import crypto from 'node:crypto';
import { encryptAtRest, decryptAtRest, safeEqual } from '@youpi/common';

const API_KEY_SALT = 'youpi_merchant_api_key_salt_v1';

/** Computes a deterministic scrypt hex digest for storing and verifying merchant API keys. */
export function hashApiKey(rawKey) {
  return crypto.scryptSync(String(rawKey), API_KEY_SALT, 32).toString('hex');
}

/** Gmail OAuth credentials are nested inside `branding.gmailConfig`; encrypt just those. */
const GMAIL_SECRET_FIELDS = ['clientSecret', 'refreshToken', 'apiKey'];

/** Serializes branding, encrypting any nested Gmail OAuth secrets and merchantApiKey. */
function serializeBranding(branding) {
  if (!branding || typeof branding !== 'object') return branding || '{"primaryColor":"#2563eb","appName":"YOUPI PG","logoUrl":null}';
  const copy = { ...branding };
  if (copy.merchantApiKey && typeof copy.merchantApiKey === 'string') {
    copy.merchantApiKey = encryptAtRest(copy.merchantApiKey);
  }
  const gmail = copy.gmailConfig;
  if (gmail && typeof gmail === 'object') {
    const enc = { ...gmail };
    for (const field of GMAIL_SECRET_FIELDS) {
      if (enc[field]) enc[field] = encryptAtRest(enc[field]);
    }
    copy.gmailConfig = enc;
  }
  return JSON.stringify(copy);
}

/** Reverses serializeBranding. Plaintext values written earlier pass through unchanged. */
function deserializeBranding(raw) {
  const branding = JSON.parse(raw || '{}');
  if (branding.merchantApiKey && typeof branding.merchantApiKey === 'string') {
    branding.merchantApiKey = decryptAtRest(branding.merchantApiKey);
  }
  const gmail = branding.gmailConfig;
  if (gmail && typeof gmail === 'object') {
    const dec = { ...gmail };
    for (const field of GMAIL_SECRET_FIELDS) {
      if (dec[field]) dec[field] = decryptAtRest(dec[field]);
    }
    branding.gmailConfig = dec;
  }
  return branding;
}

export class MerchantRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a new merchant record.
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const branding = typeof data.branding === 'object'
      ? serializeBranding(data.branding)
      : (data.branding || '{"primaryColor":"#2563eb","appName":"YOUPI PG","logoUrl":null}');
    const now = new Date().toISOString();
    const rawWebhookSecret = data.webhookSecret || crypto.randomBytes(32).toString('hex');
    const apiKeyHash = data.apiKeyHash || (data.apiKey ? hashApiKey(data.apiKey) : hashApiKey(rawWebhookSecret));

    const sql = `
      INSERT INTO merchants (id, business_name, slug, contact_email, contact_phone, webhook_url, webhook_secret, api_key_hash, branding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.businessName,
      data.slug,
      data.contactEmail,
      data.contactPhone,
      data.webhookUrl || null,
      // Webhook HMAC key must be recoverable at signing time, so it is encrypted at rest.
      encryptAtRest(rawWebhookSecret),
      apiKeyHash,
      branding,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM merchants WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findBySlug(slug) {
    const row = this.db.queryOne('SELECT * FROM merchants WHERE slug = ?', [slug]);
    if (!row) return null;
    return this.mapRow(row);
  }

  getDefault() {
    const canonical = this.findById('00000000-0000-0000-0000-000000000001');
    if (canonical) return canonical;
    const all = this.findAll();
    return all[0] || null;
  }

  findAll() {
    const rows = this.db.query(`
      SELECT * FROM merchants 
      ORDER BY CASE WHEN id = '00000000-0000-0000-0000-000000000001' THEN 0 ELSE 1 END, created_at ASC
    `);
    return rows.map(r => this.mapRow(r));
  }

  update(id, updates) {
    const fields = [];
    const params = [];

    if (updates.businessName !== undefined) {
      fields.push('business_name = ?');
      params.push(updates.businessName);
    }
    if (updates.contactEmail !== undefined) {
      fields.push('contact_email = ?');
      params.push(updates.contactEmail);
    }
    if (updates.contactPhone !== undefined) {
      fields.push('contact_phone = ?');
      params.push(updates.contactPhone);
    }
    if (updates.webhookUrl !== undefined) {
      fields.push('webhook_url = ?');
      params.push(updates.webhookUrl);
    }
    if (updates.webhookSecret !== undefined) {
      fields.push('webhook_secret = ?');
      params.push(encryptAtRest(updates.webhookSecret));
      if (updates.apiKey === undefined && updates.apiKeyHash === undefined) {
        fields.push('api_key_hash = ?');
        params.push(hashApiKey(updates.webhookSecret));
      }
    }
    if (updates.apiKey !== undefined) {
      fields.push('api_key_hash = ?');
      params.push(hashApiKey(updates.apiKey));
    } else if (updates.apiKeyHash !== undefined) {
      fields.push('api_key_hash = ?');
      params.push(updates.apiKeyHash);
    }
    if (updates.branding !== undefined) {
      fields.push('branding = ?');
      params.push(typeof updates.branding === 'object' ? serializeBranding(updates.branding) : updates.branding);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    params.push(new Date().toISOString());

    params.push(id);
    this.db.execute(`UPDATE merchants SET ${fields.join(', ')} WHERE id = ?`, params);

    return this.findById(id);
  }

  /**
   * Verifies a candidate merchant API key against the stored SHA-256 apiKeyHash.
   */
  verifyApiKey(merchant, candidateKey) {
    if (!merchant || !candidateKey || typeof candidateKey !== 'string') return false;
    const clean = candidateKey.trim();
    if (!clean) return false;
    if (merchant.apiKeyHash && safeEqual(hashApiKey(clean), merchant.apiKeyHash)) {
      return true;
    }
    return false;
  }

  /**
   * Generates and persists a new Merchant API Key (`mk_live_<48_hex_chars>`) for the merchant.
   */
  rotateApiKey(id) {
    const merchant = this.findById(id);
    if (!merchant) return null;
    const newApiKey = `mk_live_${crypto.randomBytes(24).toString('hex')}`;
    const updatedBranding = {
      ...(merchant.branding || {}),
      merchantApiKey: newApiKey
    };
    const updated = this.update(id, {
      apiKey: newApiKey,
      branding: updatedBranding
    });
    return {
      ...updated,
      merchantKey: newApiKey
    };
  }

  mapRow(row) {
    const webhookSecret = decryptAtRest(row.webhook_secret);
    const branding = deserializeBranding(row.branding);
    return {
      id: row.id,
      businessName: row.business_name,
      slug: row.slug,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      webhookUrl: row.webhook_url,
      // Plaintext rows written before encryption existed decrypt to themselves.
      webhookSecret,
      merchantKey: branding?.merchantApiKey && row.api_key_hash === hashApiKey(branding.merchantApiKey) ? branding.merchantApiKey : '',
      apiKeyHash: row.api_key_hash || null,
      branding,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
