/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { escapeHtml } from './x402.js';

describe('x402 HTML escaping', () => {
  describe('escapeHtml', () => {
    it('should escape ampersands', () => {
      const result = escapeHtml('foo&bar');
      assert.strictEqual(result, 'foo&amp;bar');
    });

    it('should escape less-than signs', () => {
      const result = escapeHtml('foo<bar');
      assert.strictEqual(result, 'foo&lt;bar');
    });

    it('should escape greater-than signs', () => {
      const result = escapeHtml('foo>bar');
      assert.strictEqual(result, 'foo&gt;bar');
    });

    it('should escape double quotes', () => {
      const result = escapeHtml('foo"bar');
      assert.strictEqual(result, 'foo&quot;bar');
    });

    it('should escape single quotes', () => {
      const result = escapeHtml("foo'bar");
      assert.strictEqual(result, 'foo&#x27;bar');
    });

    it('should escape multiple special characters', () => {
      const result = escapeHtml('<script>"alert(\'xss\')"</script>');
      assert.strictEqual(
        result,
        '&lt;script&gt;&quot;alert(&#x27;xss&#x27;)&quot;&lt;/script&gt;',
      );
    });

    it('should handle javascript: protocol injection', () => {
      const result = escapeHtml("javascript:alert('XSS')");
      assert.strictEqual(result, 'javascript:alert(&#x27;XSS&#x27;)');
    });

    it('should handle HTML injection in attribute context', () => {
      const result = escapeHtml('"><script>alert("XSS")</script>');
      assert.strictEqual(
        result,
        '&quot;&gt;&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;',
      );
    });

    it('should handle single quote HTML injection', () => {
      const result = escapeHtml("'><script>alert('XSS')</script>");
      assert.strictEqual(
        result,
        '&#x27;&gt;&lt;script&gt;alert(&#x27;XSS&#x27;)&lt;/script&gt;',
      );
    });

    it('should handle HTML entities in URL', () => {
      const result = escapeHtml('/path?param1=value&param2=value');
      assert.strictEqual(result, '/path?param1=value&amp;param2=value');
    });

    it('should not modify normal URLs', () => {
      const result = escapeHtml('/ar-io/some/path');
      assert.strictEqual(result, '/ar-io/some/path');
    });

    it('should handle empty string', () => {
      const result = escapeHtml('');
      assert.strictEqual(result, '');
    });

    it('should preserve order of escaping (ampersand first)', () => {
      // This tests that & is escaped first, so we don't double-escape
      // e.g., < becomes &lt; not &amp;lt;
      const result = escapeHtml('&<>"\'');
      assert.strictEqual(result, '&amp;&lt;&gt;&quot;&#x27;');
    });

    it('should handle complex XSS vector with event handlers', () => {
      const result = escapeHtml('" onload="alert(\'XSS\')" foo="');
      assert.strictEqual(
        result,
        '&quot; onload=&quot;alert(&#x27;XSS&#x27;)&quot; foo=&quot;',
      );
      // After escaping, this cannot break out of the attribute context
    });

    it('should handle data: URI XSS attempt', () => {
      const result = escapeHtml('data:text/html,<script>alert("XSS")</script>');
      assert.strictEqual(
        result,
        'data:text/html,&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;',
      );
    });
  });
});
