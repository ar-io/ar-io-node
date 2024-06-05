/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

declare module '@aws-lite/s3' {
  import {
    S3ClientConfig,
    GetObjectCommandInput,
    PutObjectCommandInput,
    GetObjectCommandOutput,
    PutObjectCommandOutput,
  } from '@aws-sdk/client-s3';

  interface S3Client {
    getObject(params: GetObjectCommandInput): Promise<GetObjectCommandOutput>;
  }

  export default function s3(options: S3ClientConfig): S3Client;
}
