import { expect } from 'chai';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getPageSize,
  resolveTxData,
  resolveTxFee,
  resolveTxOwner,
  resolveTxQuantity,
  resolveTxRecipient,
} from '../../../src/routes/graphql/resolvers.js';

const GQL_TX = {
  id: 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q',
  anchor: 'o0ymb8XbDEetKoMj1n02i-OBhiN_2YfGhYNRuUHpMdphCOZGCePCe26EdHbYFJ0h',
  signature:
    'TS2NVSyft8Hv-XaiozhvOb4U61cOMsdnh9FY8p4HcL3hzn533xbJv7stPyg4XXNcdZXXbb1Z-VMv94DzjtyzHc-CgGnAZbvfPBKDfYXxb46GcEo3LtDlCHmIDD-kwJUEU9h0XBK_JKdqN9n_kg9xprgq8GkTlrSSyTynVvNppwyZ1lXYLcbMovtXMOkRUQPI6SJ4T6INjVbT8D9NHwrKWzzdw0zA9IWBzn1SPzlk5jhq2kq0ZwL56tpADAQY-KiNU6U7GnVeSSd4-iHU_TE34p1XbT7noiKU27_exRgLC_-QjtiS0KjWnjR_GdvofYE_czfJUWXa-3z7dsmmLkks2qwE7B7OtB5GKTWYtKB7Ojp6V8SWCUb32Jqlt6wZHABqc0LCOO6uPws_7QK4xYWyNd-OXnBCBFacKvvz_YwQ0tX-OS5vALpQqz2j-3IrSubLfs9-CARooyD8mEXtjgzsPnzRHhhH8k9WA_bFo-KDWdWkdEIgIF7Y_OlxI2G7sMxo5ZOSdfUcQKRkmqBGWJxwss5fB2-MOjsDLLf8nd9kKtC8xiA0OkhbCit4Pt-ip-zQQW-P5ak1spjhUkxR-K3e6uVD2_i3St5jCP_JwtejjRp9brt8aLUIJiVo8GJIkChsIcxr_MA9iZvywZ2ZFNJAvY2G1PVO63lOYPjTL_JXVzo',
  recipient: '6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM',
  ownerAddress: 'k3hNqeW_8_WDBz6hwUAsu6DQ47sGXZUP5Q8MJP8BdsE',
  ownerKey:
    '0BUYi-XqwHu9NwKi7uvURVTcJgschq1MAliInZDXLXw300bN4usI6eUP-9RVLsocfcoXjNjyz6Xj603oD9iM7K8YxjTPfbLHzZ0MhphYD-1cn8fXta7PCXItjG9XIZZbkq7DCOgmljF1tjgtimQgUrjGZr3f9ddzIXDHdSzbLhrakxkeqFidXQctgIJyCInbMHenAfJyAfzLeGUO107vWmzEFDzO_-0FUYuLTQfNLhZw9WPSNKp3D8wSM2Z8BnQmuot827zrthR0vX7JAQQoTuAGREtalD4f1ysh2mcJJi9tmlN_9FCqZvhhQqrK2dJrtf11QXCQyCkKHiP47TyK2dAYnWl2mrQc9ntpMMC2Fqsa8Qb5z5zaaxGiM3mw-mLKpmTtywSVFYsn3kQtxG7_e04NIns6bL6PNLS5_7IX-6BNq8y1nHBARane4iHgQdHSBXCUkeagGTy6HjHc9g8zmRzi-VwWS8CD37bCadoVwZjA1oUB0vwvZ6pPeRQROS-iIQPuZgEQinGiuNbSbs3ezRPow1z7GbpbrYEy3Rgv3ozHZcGXwkHyohD5i0ST7H6VHZn27ieFiu48Hub0oA3XMJZRYJhBEopW8jjAQ_nPaQz-bioI2Jd_svwwlAcaIYfzUImoxYyQwzgnstkhIFk9tIFG4VratxdVH0HwOQY0jhE',
  fee: '477648',
  quantity: '7896935',
  dataSize: '0',
  contentType: undefined,
  blockIndepHash:
    'CT075juenGfi1wKif0Af-6Y9KJ2tR7kqPkeALB99eJUJnrWafqG8uq0kN4cpAN3I',
  blockTimestamp: 1639925391,
  height: 834713,
  blockPreviousBlock:
    '-WmnSux8p6DccMRwGh-jq3_wv_deZc0XsgpZnzt0WhPVpA5GmmBW14zhRMT3DbiT',
};

describe('getPageSize', () => {
  it("should return DEFAULT_PAGE_SIZE if 'first' is not set", () => {
    expect(DEFAULT_PAGE_SIZE).to.equal(getPageSize({ first: undefined }));
  });

  it("should return 'first' if it is set and less than MAX_PAGE_SIZE", () => {
    const first = MAX_PAGE_SIZE - 1;
    expect(first).to.equal(getPageSize({ first }));
  });

  it("should return MAX_PAGE_SIZE if 'first' is greater than MAX_PAGE_SIZE", () => {
    const first = MAX_PAGE_SIZE + 1;
    expect(MAX_PAGE_SIZE).to.equal(getPageSize({ first }));
  });
});

describe('resolveTxRecipient', () => {
  it('should return the recipient', () => {
    const recipient = resolveTxRecipient(GQL_TX);
    expect(recipient).to.equal('6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM');
  });

  // arweave.net compatibility
  it('should return empty string if recipient is undefined', () => {
    const tx = { ...GQL_TX, recipient: undefined };
    const recipient = resolveTxRecipient(tx);
    expect(recipient).to.equal('');
  });
});

describe('resolveTxData', () => {
  it('should return dataSize and contentType', () => {
    // TODO find a tx with content type set
    const tx = { ...GQL_TX, contentType: 'text/plain' };
    const dataResult = resolveTxData(tx);
    expect(dataResult.size).to.equal('0');
    expect(dataResult.type).to.equal('text/plain');
  });
});

describe('resolveTxQuantity', () => {
  it('should return quantity in AR and winstons', () => {
    const quantity = resolveTxQuantity(GQL_TX);
    expect(quantity.ar).to.equal('0.000007896935');
    expect(quantity.winston).to.equal('7896935');
  });
});

describe('resolveTxFee', () => {
  it('should return quantity in AR and winstons', () => {
    const fee = resolveTxFee(GQL_TX);
    expect(fee.ar).to.equal('0.000000477648');
    expect(fee.winston).to.equal('477648');
  });
});

describe('resolveTxOwner', () => {
  it('should return owner address and key', () => {
    const owner = resolveTxOwner(GQL_TX);
    expect(owner.address).to.equal(
      'k3hNqeW_8_WDBz6hwUAsu6DQ47sGXZUP5Q8MJP8BdsE',
    );
    expect(owner.key).to.equal(
      '0BUYi-XqwHu9NwKi7uvURVTcJgschq1MAliInZDXLXw300bN4usI6eUP-9RVLsocfcoXjNjyz6Xj603oD9iM7K8YxjTPfbLHzZ0MhphYD-1cn8fXta7PCXItjG9XIZZbkq7DCOgmljF1tjgtimQgUrjGZr3f9ddzIXDHdSzbLhrakxkeqFidXQctgIJyCInbMHenAfJyAfzLeGUO107vWmzEFDzO_-0FUYuLTQfNLhZw9WPSNKp3D8wSM2Z8BnQmuot827zrthR0vX7JAQQoTuAGREtalD4f1ysh2mcJJi9tmlN_9FCqZvhhQqrK2dJrtf11QXCQyCkKHiP47TyK2dAYnWl2mrQc9ntpMMC2Fqsa8Qb5z5zaaxGiM3mw-mLKpmTtywSVFYsn3kQtxG7_e04NIns6bL6PNLS5_7IX-6BNq8y1nHBARane4iHgQdHSBXCUkeagGTy6HjHc9g8zmRzi-VwWS8CD37bCadoVwZjA1oUB0vwvZ6pPeRQROS-iIQPuZgEQinGiuNbSbs3ezRPow1z7GbpbrYEy3Rgv3ozHZcGXwkHyohD5i0ST7H6VHZn27ieFiu48Hub0oA3XMJZRYJhBEopW8jjAQ_nPaQz-bioI2Jd_svwwlAcaIYfzUImoxYyQwzgnstkhIFk9tIFG4VratxdVH0HwOQY0jhE',
    );
  });
});
