import fs from 'fs';
import stream from 'stream';

export const stubTxID = '0000000000000000000000000000000000000000000';
export const stubAns104Bundle = async (): Promise<stream.Readable> => {
  return await fs.createReadStream(`./test/mock_files/ans104_bundle`);
};
