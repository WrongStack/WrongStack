import type { CommandDetailMap } from './command-detail-types';
import { commandDetailsPart1 } from './command-details-part-1';
import { commandDetailsPart2 } from './command-details-part-2';
import { commandDetailsPart3 } from './command-details-part-3';
import { commandDetailsPart4 } from './command-details-part-4';

export type { CommandDetail, CommandDetailMap } from './command-detail-types';
export { surfaceListSentence } from './command-detail-types';

export const commandDetails: CommandDetailMap = {
  ...commandDetailsPart1,
  ...commandDetailsPart2,
  ...commandDetailsPart3,
  ...commandDetailsPart4,
};
