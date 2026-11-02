import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateStandSvg,
  generateStandHtml,
  formatIndianMobile
} from '../stand-generator.js';

describe('Stand Generator Unit Tests', () => {
  describe('formatIndianMobile', () => {
    test('formats standard 10-digit Indian mobile number', () => {
      assert.equal(formatIndianMobile('9876543210'), '+91 98765 43210');
      assert.equal(formatIndianMobile('+919876543210'), '+91 98765 43210');
      assert.equal(formatIndianMobile('91 9876543210'), '+91 98765 43210');
    });

    test('handles empty or malformed inputs gracefully', () => {
      assert.equal(formatIndianMobile(''), '');
      assert.equal(formatIndianMobile('123'), '123');
    });
  });

  describe('generateStandSvg', () => {
    test('throws error if payee VPA is invalid', () => {
      assert.throws(() => {
        generateStandSvg({
          businessName: 'Sharma Sweets',
          payeeVpa: 'invalid-vpa-format',
          phonePeMobile: '9876543210'
        });
      }, /Invalid payee VPA/);
    });

    test('generates valid table-tent SVG with merchant branding, VPA, and PhonePe mobile', () => {
      const svg = generateStandSvg({
        businessName: 'Sharma Sweets & Bakers',
        payeeVpa: 'sharmasweets@ybl',
        phonePeMobile: '9876543210',
        primaryColor: '#5f259f'
      });

      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.endsWith('</svg>'));
      assert.ok(svg.includes('viewBox="0 0 1200 1800"'));
      assert.ok(svg.includes('Sharma Sweets &amp; Bakers'));
      assert.ok(svg.includes('UPI ID: sharmasweets@ybl'));
      assert.ok(svg.includes('PhonePe Number: +91 98765 43210'));
      assert.ok(svg.includes('Camera Scan Accepts Payments Above ₹2,000'));
      assert.ok(svg.includes('PhonePe'));
      assert.ok(svg.includes('Google Pay'));
      assert.ok(svg.includes('Paytm'));
    });

    test('generates compact desk-badge square format', () => {
      const svg = generateStandSvg({
        businessName: 'Quick Mart',
        payeeVpa: 'quickmart@upi',
        phonePeMobile: '9812345678',
        format: 'desk-badge'
      });

      assert.ok(svg.includes('viewBox="0 0 1050 1050"'));
      assert.ok(svg.includes('Quick Mart'));
      assert.ok(svg.includes('quickmart@upi'));
      assert.ok(svg.includes('+91 98123 45678'));
    });

    test('generates dynamic counter QR stand with prefilled amount', () => {
      const svg = generateStandSvg({
        businessName: 'Boutique Store',
        payeeVpa: 'boutique@icici',
        phonePeMobile: '9988776655',
        amountPaise: 350000n // ₹3,500
      });

      assert.ok(svg.includes('Boutique Store'));
      assert.ok(svg.includes('boutique@icici'));
      assert.ok(svg.includes('<rect'));
    });
  });


    test('generates beautiful Diwali festival standee with Diyas and MOMO IT TECHNOLOGIES branding', () => {
      const svg = generateStandSvg({
        businessName: 'VISHNU CRACKERS - KADAPA',
        payeeVpa: '7093259556-3@ybl',
        phonePeMobile: '7093259556',
        payeeName: 'ESUKAPALLI VISHNU VA',
        theme: 'diwali',
        poweredBy: 'MOMO IT TECHNOLOGIES',
        format: 'table-tent'
      });

      assert.ok(svg.includes('HAPPY DIWALI'));
      assert.ok(svg.includes('VISHNU CRACKERS'));
      assert.ok(svg.includes('- KADAPA -'));
      assert.ok(svg.includes('ESUKAPALLI VISHNU VA'));
      assert.ok(svg.includes('7093259556-3@ybl'));
      assert.ok(svg.includes('+91 70932 59556'));
      assert.ok(svg.includes('POWERED BY MOMO IT TECHNOLOGIES'));
      assert.ok(svg.includes('Camera Scan Accepts All Amounts Above ₹2,000'));
      assert.ok(svg.includes('flameGrad'));
    });

  describe('generateStandHtml', () => {
    test('generates standalone printable HTML document with print CSS', () => {
      const html = generateStandHtml({
        businessName: 'Grand Restaurant',
        payeeVpa: 'grand@ybl',
        phonePeMobile: '9876543210'
      });

      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('<title>Payment QR Stand - Grand Restaurant</title>'));
      assert.ok(html.includes('@media print'));
      assert.ok(html.includes('downloadSvg()'));
      assert.ok(html.includes('Grand Restaurant'));
      assert.ok(html.includes('grand@ybl'));
    });
  });
});
