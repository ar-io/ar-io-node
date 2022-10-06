/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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

const DEFAULT_FAILURE_RATE = 0;

export interface FailureSimulator {
  maybeFail(): void;
}

export class UniformFailureSimulator {
  private failureRate;

  constructor({ failureRate = DEFAULT_FAILURE_RATE }) {
    this.failureRate = failureRate;
  }

  public maybeFail() {
    if (Math.random() < this.failureRate) {
      throw new Error('Simulated failure');
    }
  }
}
