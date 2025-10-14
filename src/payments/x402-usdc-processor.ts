/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { useFacilitator } from 'x402/verify';
import {
  ERC20TokenAmount,
  PaymentPayload,
  PaymentRequirements,
  settleResponseHeader,
} from 'x402/types';
import { decodePayment } from 'x402/schemes';
import {
  processPriceToAtomicAmount,
  toJsonSafe,
  getPaywallHtml,
} from 'x402/shared';
import log from '../log.js';
import {
  PaymentProcessor,
  PaymentVerificationResult,
  PaymentSettlementResult,
  PaymentRequirementsContext,
} from './types.js';

/**
 * Configuration options for x402 USDC payment processor
 */
export interface X402UsdcProcessorConfig {
  walletAddress: `0x${string}`;
  network: 'base' | 'base-sepolia';
  perBytePrice: number;
  minPrice: number;
  maxPrice: number;
  facilitatorUrl: `${string}://${string}`;
  settleTimeoutMs: number;
  version: number;
  // Paywall customization
  cdpClientKey?: string;
  appName?: string;
  appLogo?: string;
  sessionTokenEndpoint?: string;
}

/**
 * x402 USDC payment processor implementation
 */
export class X402UsdcProcessor implements PaymentProcessor {
  private config: X402UsdcProcessorConfig;
  private facilitator: ReturnType<typeof useFacilitator>;

  constructor(config: X402UsdcProcessorConfig) {
    this.config = config;
    this.facilitator = useFacilitator({
      url: config.facilitatorUrl,
    });
  }

  /**
   * Calculate x402 USDC per byte egress price based on content size
   */
  private calculatePrice(contentLength: number): string {
    const priceInUSD = contentLength * this.config.perBytePrice;
    const clampedPrice = Math.min(
      Math.max(priceInUSD, this.config.minPrice),
      this.config.maxPrice,
    );
    // Format to 3 decimal places for consistent, readable pricing
    const formattedPrice = clampedPrice.toFixed(3);
    return `$${formattedPrice}`;
  }

  /**
   * Check if a request is from a browser
   */
  public isBrowserRequest(req: Request): boolean {
    const acceptHeader = req.header('Accept');
    const userAgent = req.header('User-Agent');
    if (acceptHeader === undefined || userAgent === undefined) {
      return false;
    }
    return acceptHeader.includes('text/html') && userAgent.includes('Mozilla');
  }

  /**
   * Calculate payment requirements based on content context
   */
  public calculateRequirements(
    context: PaymentRequirementsContext,
  ): PaymentRequirements {
    const price = this.calculatePrice(context.contentSize);
    const atomicAssetPrice = processPriceToAtomicAmount(
      price,
      this.config.network,
    );

    if ('error' in atomicAssetPrice) {
      throw new Error(`Invalid price format: ${price}`);
    }

    return {
      scheme: 'exact' as const,
      description: `AR.IO Gateway data egress for ${context.contentSize} bytes`,
      network: this.config.network,
      maxAmountRequired: atomicAssetPrice.maxAmountRequired,
      payTo: this.config.walletAddress,
      asset: atomicAssetPrice.asset.address,
      resource: `${context.protocol}://${context.host}${context.originalUrl}`,
      mimeType: context.contentType,
      maxTimeoutSeconds: 300, // 5 minutes
      extra: (atomicAssetPrice.asset as ERC20TokenAmount['asset']).eip712,
    };
  }

  /**
   * Extract and decode payment from request headers
   */
  public extractPayment(req: Request): PaymentPayload | undefined {
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (paymentHeader === undefined) {
      return undefined;
    }

    try {
      const paymentPayload = decodePayment(paymentHeader);
      paymentPayload.x402Version = this.config.version;
      return paymentPayload;
    } catch (error: any) {
      log.error('[X402UsdcProcessor] Failed to decode payment header', {
        error: error.message,
      });
      throw new Error('Invalid payment header');
    }
  }

  /**
   * Verify a payment payload against requirements
   */
  public async verifyPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<PaymentVerificationResult> {
    // Validate that the payment payload matches our requirements
    if (paymentPayload.scheme !== requirements.scheme) {
      return {
        isValid: false,
        invalidReason: 'Payment scheme mismatch',
      };
    }

    if (paymentPayload.network !== requirements.network) {
      return {
        isValid: false,
        invalidReason: 'Payment network mismatch',
      };
    }

    try {
      // Verify the payment using facilitator
      const verifyResponse = await this.facilitator.verify(
        paymentPayload,
        requirements,
      );

      log.debug('[X402UsdcProcessor] Payment verification response', {
        verifyResponse,
      });

      // isValid indicates the payment is unique and has not been settled on chain yet
      if (!verifyResponse.isValid) {
        return {
          isValid: false,
          invalidReason: verifyResponse.invalidReason || 'Invalid payment',
          payer: verifyResponse.payer,
        };
      }

      return {
        isValid: true,
        payer: verifyResponse.payer,
      };
    } catch (error: any) {
      log.error('[X402UsdcProcessor] Payment verification error', {
        error: error.message,
      });
      return {
        isValid: false,
        invalidReason: 'Payment verification failed',
      };
    }
  }

  /**
   * Settle a verified payment
   */
  public async settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<PaymentSettlementResult> {
    try {
      log.debug('[X402UsdcProcessor] Settling payment', {
        paymentPayload,
        requirements,
      });

      // Wrap settlement with timeout to prevent indefinite hanging
      const settlementResult = await Promise.race([
        this.facilitator.settle(paymentPayload, requirements),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Settlement timeout')),
            this.config.settleTimeoutMs,
          ),
        ),
      ]);

      const settlementResultHeader = settleResponseHeader(settlementResult);

      log.debug('[X402UsdcProcessor] Payment settlement result', {
        settlementResult,
      });

      if (!settlementResult.success) {
        return {
          success: false,
          errorReason: settlementResult.errorReason,
          responseHeader: settlementResultHeader,
        };
      }

      return {
        success: true,
        responseHeader: settlementResultHeader,
      };
    } catch (error: any) {
      log.error('[X402UsdcProcessor] Payment settlement error', {
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        errorReason: error.message ?? 'settlement_error',
      };
    }
  }

  /**
   * Send a 402 payment required response
   */
  public sendPaymentRequiredResponse(
    req: Request,
    res: Response,
    requirements: PaymentRequirements,
    options?: {
      error?: string;
      message?: string;
      payer?: string;
      price?: string;
    },
  ): void {
    // Check if this is a browser request and return HTML paywall
    if (this.isBrowserRequest(req)) {
      // Calculate display amount from price or payment requirements
      let displayAmount: number;
      if (options?.price !== undefined && options.price.length > 0) {
        // Parse price like "$0.001"
        const parsed = options.price.replace('$', '');
        displayAmount = parseFloat(parsed);
      } else {
        // Calculate from maxAmountRequired (which is in atomic units)
        // For USDC, 6 decimals
        displayAmount = parseInt(requirements.maxAmountRequired) / 1000000;
      }

      const html = getPaywallHtml({
        amount: displayAmount,
        paymentRequirements: toJsonSafe([requirements]) as any,
        currentUrl: req.originalUrl,
        testnet: this.config.network === 'base-sepolia',
        cdpClientKey: this.config.cdpClientKey,
        appName: this.config.appName,
        appLogo: this.config.appLogo,
        sessionTokenEndpoint: this.config.sessionTokenEndpoint,
      });
      res.status(402).send(html);
      return;
    }

    // Return JSON for API clients
    res.status(402).json({
      x402Version: this.config.version,
      accepts: [requirements],
      error: options?.error,
      message: options?.message,
      payer: options?.payer,
    });
  }
}
