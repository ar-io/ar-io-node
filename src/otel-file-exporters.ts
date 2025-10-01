/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * File-based span exporter for development and debugging.
 * Writes spans to a JSONL file (one JSON object per line).
 *
 * NOTE: This exporter is intended for development/debugging only.
 * Production deployments should use OTLP exporters with proper collectors.
 */
export class FileSpanExporter implements SpanExporter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;

    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Export spans to file.
   * @param spans - Spans to export
   * @param resultCallback - Callback with export result
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    try {
      for (const span of spans) {
        const spanInfo = this._exportInfo(span);
        const jsonLine = JSON.stringify(spanInfo) + '\n';
        appendFileSync(this.filePath, jsonLine, 'utf8');
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      console.error('Error exporting spans to file:', error);
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Shutdown the exporter.
   */
  async shutdown(): Promise<void> {
    // Nothing to clean up for file-based exporter
    return Promise.resolve();
  }

  /**
   * Force flush any pending spans.
   */
  async forceFlush(): Promise<void> {
    // File writes are synchronous, nothing to flush
    return Promise.resolve();
  }

  /**
   * Convert span into readable format for file export.
   * @param span - Span to convert
   */
  private _exportInfo(span: ReadableSpan): Record<string, unknown> {
    return {
      timestamp: new Date(
        span.startTime[0] * 1000 + span.startTime[1] / 1e6,
      ).toISOString(),
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      name: span.name,
      kind: span.kind,
      startTime: span.startTime,
      endTime: span.endTime,
      duration:
        (span.endTime[0] - span.startTime[0]) * 1000 +
        (span.endTime[1] - span.startTime[1]) / 1e6,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links,
      resource: {
        attributes: span.resource.attributes,
      },
    };
  }
}
