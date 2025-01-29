/* eslint-disable header/header */

/**
 * Copyright (c) 2020 François Parmentier.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// note: this file is based on the library random-weighted-choice
// but it differs in that it allows for multiple choices to be made at once

// random-weighted-choice 0.1.4 was published to npm registry under MIT liecense

// Represents a single item that can be chosen, along with its weight.
// `weight` is used to determine how likely the item is to be selected.
export type WeightedElement<T> = {
  id: T;
  weight: number;
};

// Arguments for randomWeightedChoices
type RandomWeightedChoicesArgs<T> = {
  // The array of weighted elements from which we want to draw.
  table: WeightedElement<T>[];

  // Number of items (IDs) to return. Defaults to 1.
  count?: number;

  // A "temperature"-like parameter that modifies how weights are shifted
  // (e.g., closer or further from the average weight). Defaults to 50.
  temperature?: number;

  // Optional function to use for generating random numbers,
  // allowing custom randomization. Defaults to Math.random.
  randomFunction?: () => number;

  // Another parameter that influences how strongly `temperature` affects
  // the adjusted weights. Defaults to 2.
  influence?: number;
};

export const randomWeightedChoices = <T>({
  table,
  count = 1,
  temperature = 50,
  randomFunction = Math.random,
  influence = 2,
}: RandomWeightedChoicesArgs<T>): T[] => {
  // Translate temperature from range [0..100] to [-1..+1].
  // T=0 means temperature=50, T=+1 means temperature=100, T=-1 means temperature=0.
  const T = (temperature - 50) / 50;

  // Number of elements in the input table.
  const nb = table.length;

  // If the table is empty, return an empty result immediately.
  if (!nb) {
    return [];
  }

  // Calculate the total sum of the original weights.
  const total = table.reduce(
    (previousTotal, element) => previousTotal + element.weight,
    0,
  );

  // Compute the average weight across all elements.
  const avg = total / nb;

  // This object will store recalculated weights ("urgencies") for each element's ID.
  const urgencies: Record<string, number> = {};

  // Compute the sum of all recalculated "urgencies" after adjusting
  // based on temperature and influence.
  const urgencySum = table.reduce((previousSum, element) => {
    const { id, weight } = element;

    // Move the weight closer or further from the average,
    // depending on the sign of T (temperature).
    // If T is positive, weights below avg get boosted; weights above avg get reduced, etc.
    let urgency = weight + T * influence * (avg - weight);

    // Ensure that no urgency is below zero.
    if (urgency < 0) urgency = 0;

    // Accumulate the urgency for this ID in the urgencies object.
    // (In most cases, each ID appears once, but this is generalized.)
    urgencies[id as string] = (urgencies[id as string] || 0) + urgency;

    // Add this element's urgency to the running total.
    return previousSum + urgency;
  }, 0);

  // If the total urgency is zero or negative (all were clamped to zero),
  // there is nothing to pick from.
  if (urgencySum <= 0) {
    return [];
  }

  // Construct a running total of urgencies for each ID.
  // This cumulative sum is used to pick weighted random elements
  // using a "roulette wheel" approach.
  let currentUrgency = 0;
  const cumulatedUrgencies: Record<string, number> = {};

  Object.keys(urgencies).forEach((id) => {
    currentUrgency += urgencies[id];
    cumulatedUrgencies[id] = currentUrgency;
  });

  // This array will hold the final selected item IDs.
  const results: T[] = [];

  // We ensure we don’t pick more items than exist in the table.
  // In unusual edge cases, we retry up to 100 times to get `count` distinct items.
  let i = 0;
  while (results.length < count && i++ < 100) {
    // Pick a random number in the range [0, urgencySum).
    const choice = randomFunction() * urgencySum;

    // Filter out IDs we already picked to avoid duplicates.
    const ids = Object.keys(cumulatedUrgencies).filter(
      (id) => !results.includes(id as unknown as T),
    );

    // Go through the available IDs in order.
    // The first ID whose cumulative urgency is >= `choice` is the chosen one.
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j];
      const urgency = cumulatedUrgencies[id];

      if (choice <= urgency) {
        results.push(id as unknown as T);
        break;
      }
    }
  }

  // Return the array of chosen IDs.
  return results;
};
