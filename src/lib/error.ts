/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

interface DetailedErrorOptions {
  stack?: string;
  [key: string]: any; // Allow any other properties with any value type
}

export class DetailedError extends Error {
  constructor(message: string, options?: DetailedErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, options);
    this.stack = options?.stack ?? new Error().stack;
  }

  toJSON() {
    const { name, message, ...rest } = this;
    return {
      message: this.message,
      stack: this.stack,
      ...rest,
    };
  }

  static fromJSON(json: any): DetailedError {
    const { message, ...options } = json;

    return new DetailedError(message, options);
  }
}
