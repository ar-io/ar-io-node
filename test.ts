import axios from 'axios';
import { read } from 'fs';
import { Readable } from 'stream';

const fetch = async (): Promise<any> => {
  /**
   * 1. Fetch /chunk/{offset} from arweave nodes
   * 2. Validate chunk
   * 3. Return metadata and data (using buffers for binary data)
   */
  // const size = await getTxData('725Y52PoIg724Hash6Lxoq86tqC25AKr5-JH45QIKd8');
  // console.log('valid tx data:', size);
  const size = 888
  const data = Buffer.alloc(size);
  console.log(data.byteLength === size);
};

const getTxData = async (txId: string): Promise<any> => {
  try {
    const response = await axios.get(
      `https://arweave.dev/tx/${txId}/data_size`,
    );
    return +response.data;
  } catch (error: any) {
    console.log('Error');
    throw error;
  }
};

(async () => {
  await fetch();
})();
