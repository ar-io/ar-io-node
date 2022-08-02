import { ArNSContract, ArNSDatabase, ArNSMapping } from '../types';

export class StandaloneArNSDatabase implements ArNSDatabase {
  async resetToHeight(height: number): Promise<void> {
    console.log(height);
    return;
  }
  async getANTContract(id: string): Promise<ArNSContract | undefined> {
    return id === 'gh673M0Koh941OIITVXl9hKabRaYWABQUedZxW-swIA'
      ? {
          id: 'gh673M0Koh941OIITVXl9hKabRaYWABQUedZxW-swIA',
          owner: 'dylan',
          height: 100
        }
      : undefined;
  }

  async getWhitelistedContracts(): Promise<ArNSContract[] | string[]> {
    return [
      '7hL0La2KMapdJI6yIGnb4f4IjvhlGQyXnqpWc0i0d_w',
      'cNr6JPVu3rEOwIbdnu3lVipz9pwY5Pps9mxHSW7Jdtk',
      'JIIB01pRbNK2-UyNxwQK-6eknrjENMTpTvQmB8ZDzQg',
      'PEI1efYrsX08HUwvc6y-h6TSpsNlo2r6_fWL2_GdwhY'
    ];
  }

  async getArNSMapping(subdomain: string): Promise<ArNSMapping | void> {
    console.log(subdomain);
    return;
  }

  async saveArNSMapping(record: ArNSMapping): Promise<void> {
    console.log(record);
    return;
  }
}
