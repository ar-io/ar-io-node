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
    },
  ): void;

  /**
   * Extract and decode payment from request headers
   * @param req Express request object
   * @returns PaymentPayload or undefined if no payment header
   */
  extractPayment(req: Request): PaymentPayload | undefined;

  /**
   * Check if request should use redirect mode (for browser paywall)
   * This checks for the x-redirect query parameter to determine if
   * the payment-authorized response should redirect instead of delivering content
   * @param req Express request object
   * @returns boolean indicating if redirect mode should be used
   */
  shouldUseRedirectMode(req: Request): boolean;

  /**
   * Send an HTML redirect response after successful payment verification
   * This is used in redirect mode to avoid blob URLs that lose content metadata
   * @param req Express request object
   * @param res Express response object
   */
  sendRedirectResponse(req: Request, res: Response): void;
}
