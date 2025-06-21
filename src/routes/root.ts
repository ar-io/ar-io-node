/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Router } from 'express';
import { arIoInfoHandler } from './ar-io.js';

export const rootRouter = Router();

rootRouter.get('/', arIoInfoHandler);
