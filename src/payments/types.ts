/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { PaymentPayload, PaymentRequirements } from 'x402/types';

/**
 * Result of payment verification
 */
export interface PaymentVerificationResult {
  /** Whether the payment is valid */
  isValid: boolean;
  /** Reason for invalid payment, if any */
  invalidReason?: string;
  /** Payer address */
  payer?: string;
}

/**
 * Result of payment settlement
 */
export interface PaymentSettlementResult {
  /** Whether settlement succeeded */
  success: boolean;
  /** Error reason if settlement failed */
  errorReason?: string;
  /** Settlement response header value */
  responseHeader?: string;
}

/**
 * Context for calculating payment requirements
 */
export interface PaymentRequirementsContext {
  /** Content size in bytes */
  contentSize: number;
  /** Content type / MIME type */
  contentType: string;
  /** Request protocol (http/https) */
  protocol: string;
  /** Request host */
  host: string;
  /** Request original URL */
  originalUrl: string;
}

/**
 * Payment processor interface for handling payment operations
 */
export interface PaymentProcessor {
  /**
   * Check if a request is from a browser (for HTML paywall vs JSON response)
   * @param req Express request object
   * @returns boolean indicating if request is from browser
   */
  isBrowserRequest(req: Request): boolean;

  /**
   * Calculate payment requirements based on content context
   * @param context Payment requirements context
   * @returns PaymentRequirements for the content
   */
  calculateRequirements(
    context: PaymentRequirementsContext,
  ): PaymentRequirements;

  /**
   * Verify a payment payload against requirements
   * @param paymentPayload Payment payload from x-payment header
   * @param requirements Payment requirements for the resource
   * @returns Promise<PaymentVerificationResult>
   */
  verifyPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<PaymentVerificationResult>;

  /**
   * Settle a verified payment
   * @param paymentPayload Payment payload from x-payment header
   * @param requirements Payment requirements for the resource
   * @returns Promise<PaymentSettlementResult>
   */
  settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<PaymentSettlementResult>;

  /**
   * Send a 402 payment required response
   * @param req Express request object
   * @param res Express response object
   * @param requirements Payment requirements for the resource
   * @param options Optional additional response data
   */
  sendPaymentRequiredResponse(
    req: Request,
    res: Response,
    requirements: PaymentRequirements,
    options?: {
      error?: string;
      message?: string;
      payer?: string;
      price?: string;
      /**
       * Browser payment flow strategy: 'redirect' to send the user to a hosted
       * paywall URL, or 'direct' to render the paywall inline
       * (internal implementation detail, not sent to clients)
       */
      browserPaymentFlow?: 'redirect' | 'direct';
    },
  ): void;

  /**
   * Extract and decode payment from request headers
   * @param req Express request object
   * @returns PaymentPayload or undefined if no payment header
   */
  extractPayment(req: Request): PaymentPayload | undefined;
}
