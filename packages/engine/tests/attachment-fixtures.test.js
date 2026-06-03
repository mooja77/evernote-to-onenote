'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { parseEnexFile } = require('../src/enex-parser');
const { enmlToHtmlWithResources } = require('../src/enml-converter');
const path = require('path');

describe('Attachment Fixtures — PDF, Large Image, Mixed', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  describe('pdf-attachment.enex', () => {
    let notes;

    test('parses successfully', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, 'Note with PDF');
    });

    test('extracts resource with correct MIME type', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      assert.equal(resource.mime, 'application/pdf');
    });

    test('base64 decodes correctly', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data, 'base64');
      // Check for PDF magic bytes
      assert.equal(buf[0], 0x25); // %
      assert.equal(buf[1], 0x50); // P
      assert.equal(buf[2], 0x44); // D
      assert.equal(buf[3], 0x46); // F
    });

    test('MD5 hash matches expected value', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data.replace(/\s+/g, ''), 'base64');
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      assert.equal(hash, '805f8aeda079196d6cedbfc6edccc5de');
    });

    test('filename is preserved', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      assert.equal(resource.fileName, 'document.pdf');
    });

    test('en-media hash matches MD5 of resource data', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data.replace(/\s+/g, ''), 'base64');
      const hash = crypto.createHash('md5').update(buf).digest('hex');

      // Check ENML content contains the correct hash
      assert.match(notes[0].content, /hash="805f8aeda079196d6cedbfc6edccc5de"/i);
      assert.equal(hash, '805f8aeda079196d6cedbfc6edccc5de');
    });

    test('enml-converter resolves PDF to object element', async () => {
      const filePath = path.join(fixturesDir, 'pdf-attachment.enex');
      notes = await parseEnexFile(filePath);

      // Prepare resources
      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      const { html, usedResources } = enmlToHtmlWithResources(notes[0].content, resources);

      assert.match(html, /<object data="name:part1"/);
      assert.match(html, /data-attachment="document\.pdf"/);
      assert.match(html, /type="application\/pdf"/);
      assert.equal(usedResources.length, 1);
      assert.equal(usedResources[0].contentType, 'application/pdf');
    });
  });

  describe('large-image.enex (>100KB)', () => {
    let notes;

    test('parses successfully', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, 'Note with Large Image');
    });

    test('resource data is correctly decoded to >100KB buffer', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data.replace(/\s+/g, ''), 'base64');
      assert(buf.length > 100000, `Expected > 100000 bytes, got ${buf.length}`);
    });

    test('MIME type is image/jpeg', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      assert.equal(resource.mime, 'image/jpeg');
    });

    test('JPEG magic bytes are present', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data.replace(/\s+/g, ''), 'base64');
      // JPEG SOI marker (0xFF 0xD8)
      assert.equal(buf[0], 0xff);
      assert.equal(buf[1], 0xd8);
    });

    test('MD5 hash is computed correctly', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const buf = Buffer.from(resource.data.replace(/\s+/g, ''), 'base64');
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      // Should match the hash in the ENML
      assert.match(notes[0].content, new RegExp(`hash="${hash}"`, 'i'));
    });

    test('enml-converter resolves JPEG to img element', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);

      // Prepare resources
      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      const { html, usedResources } = enmlToHtmlWithResources(notes[0].content, resources);

      assert.match(html, /<img src="name:part1" \/>/);
      assert.equal(usedResources.length, 1);
      assert.equal(usedResources[0].contentType, 'image/jpeg');
      assert(usedResources[0].data.length > 100000);
    });

    test('filename contains Windows-safe characters', async () => {
      const filePath = path.join(fixturesDir, 'large-image.enex');
      notes = await parseEnexFile(filePath);
      const resource = notes[0].resources[0];
      const filename = resource.fileName;
      // Check no forbidden Windows characters: < > : " / \ | ? *
      assert.doesNotMatch(filename, /[<>:"\\/|?*]/);
    });
  });

  describe('mixed-attachments.enex (PDF + Image + Octet-stream)', () => {
    let notes;

    test('parses successfully with 3 resources', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].resources.length, 3);
    });

    test('first resource is PDF', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes[0].resources[0].mime, 'application/pdf');
      assert.equal(notes[0].resources[0].fileName, 'document.pdf');
    });

    test('second resource is PNG image', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes[0].resources[1].mime, 'image/png');
      assert.equal(notes[0].resources[1].fileName, 'tiny.png');
    });

    test('third resource is octet-stream (unknown MIME)', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);
      assert.equal(notes[0].resources[2].mime, 'application/octet-stream');
      assert.equal(notes[0].resources[2].fileName, 'unknown.bin');
    });

    test('all three hashes decode and match their buffers', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);

      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      assert.equal(resources[0].hash, '805f8aeda079196d6cedbfc6edccc5de');
      assert.equal(resources[1].hash, 'ac9b2a366f87f5b6940ac516b6d36a72');
      assert.equal(resources[2].hash, 'd49b150881bb4d5f0e553051744d8ca1');
    });

    test('enml-converter resolves all 3 resources correctly', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);

      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      const { html, usedResources } = enmlToHtmlWithResources(notes[0].content, resources);

      // Should have 3 resolved resources
      assert.equal(usedResources.length, 3);

      // First: PDF → object
      assert.match(html, /<object data="name:part1"/);
      assert.match(html, /type="application\/pdf"/);

      // Second: PNG → img
      assert.match(html, /<img src="name:part2" \/>/);

      // Third: octet-stream → object
      assert.match(html, /<object data="name:part3"/);
      assert.match(html, /type="application\/octet-stream"/);
    });

    test('unknown MIME type (octet-stream) becomes <object> element', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);

      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      const { html, usedResources } = enmlToHtmlWithResources(notes[0].content, resources);

      // Find the octet-stream resource
      const octetResource = usedResources.find(r => r.contentType === 'application/octet-stream');
      assert(octetResource);
      assert.equal(octetResource.partName, 'part3');
      assert.match(html, new RegExp(`data-attachment="unknown\\.bin"`));
    });

    test('image resource content type is recognized correctly', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);

      const resources = notes[0].resources.map(r => ({
        hash: crypto.createHash('md5').update(
          Buffer.from(r.data.replace(/\s+/g, ''), 'base64')
        ).digest('hex'),
        mime: r.mime,
        filename: r.fileName,
        data: Buffer.from(r.data.replace(/\s+/g, ''), 'base64'),
      }));

      const { usedResources } = enmlToHtmlWithResources(notes[0].content, resources);

      // Second resource should be the image
      const imgResource = usedResources[1];
      assert.equal(imgResource.contentType, 'image/png');
    });

    test('all filenames are Windows-safe', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      notes = await parseEnexFile(filePath);

      const forbiddenChars = /[<>:"\\/|?*]/;
      notes[0].resources.forEach(r => {
        assert.doesNotMatch(r.fileName, forbiddenChars,
          `Filename "${r.fileName}" contains forbidden Windows characters`);
      });
    });
  });

  describe('Robustness: Edge Cases', () => {
    test('handles resource with missing filename gracefully', async () => {
      const filePath = path.join(fixturesDir, 'mixed-attachments.enex');
      const notes = await parseEnexFile(filePath);

      // Create a resource without filename
      const resWithoutName = {
        hash: 'abc123',
        mime: 'application/pdf',
        filename: '',
        data: Buffer.from('test'),
      };

      const { html } = enmlToHtmlWithResources(
        '<en-note><en-media type="application/pdf" hash="abc123"/></en-note>',
        [resWithoutName]
      );

      // Should create object with data-attachment set to partN when filename missing
      assert.match(html, /<object/);
    });

    test('handles case-insensitive hash matching', async () => {
      const resource = {
        hash: 'AABBCCDD',
        mime: 'image/png',
        filename: 'test.png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      };

      const enml = '<en-note><en-media type="image/png" hash="aabbccdd"/></en-note>';
      const { html } = enmlToHtmlWithResources(enml, [resource]);

      // Should match despite case difference
      assert.match(html, /<img src="name:part1" \/>/);
    });

    test('data buffer is not modified by converter', async () => {
      const originalData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const hash = crypto.createHash('md5').update(originalData).digest('hex');
      const resource = {
        hash,
        mime: 'application/octet-stream',
        filename: 'data.bin',
        data: originalData,
      };

      const enml = `<en-note><en-media type="application/octet-stream" hash="${hash}"/></en-note>`;
      const { usedResources } = enmlToHtmlWithResources(enml, [resource]);

      assert.equal(usedResources.length, 1);
      assert.deepEqual(usedResources[0].data, originalData);
    });
  });
});
