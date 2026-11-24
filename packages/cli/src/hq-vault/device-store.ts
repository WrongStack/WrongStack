/** This machine's HQ device identity lives in `@wrongstack/hq` (`vault/device-store.ts`). */
export {
  type HqDeviceRecord,
  hqDeviceFilePath,
  hqDeviceFingerprint,
  readHqDevice,
  removeHqDevice,
  writeHqDevice,
} from '@wrongstack/hq';
