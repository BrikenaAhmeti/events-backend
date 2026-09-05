import { ApplicationError } from '../errors/application.error';

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_EXPANDED_SIZE = 100 * 1024 * 1024;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

export const validateOfficeArchive = (buffer: Buffer): void => {
  const directoryEnd = findDirectoryEnd(buffer);
  if (buffer.readUInt16LE(directoryEnd + 4) !== 0 || buffer.readUInt16LE(directoryEnd + 6) !== 0)
    rejectUnsafeArchive();
  const diskEntries = buffer.readUInt16LE(directoryEnd + 8);
  const entries = buffer.readUInt16LE(directoryEnd + 10);
  const directorySize = buffer.readUInt32LE(directoryEnd + 12);
  const directoryOffset = buffer.readUInt32LE(directoryEnd + 16);
  if (
    entries === 0 ||
    entries === 0xffff ||
    entries !== diskEntries ||
    entries > MAX_ARCHIVE_ENTRIES ||
    directorySize === 0xffffffff ||
    directoryOffset + directorySize > directoryEnd
  )
    rejectUnsafeArchive();

  let offset = directoryOffset;
  let expandedSize = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE)
      rejectUnsafeArchive();
    const entrySize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;

    if (entrySize === 0xffffffff || nextOffset > directoryEnd) rejectUnsafeArchive();

    expandedSize += entrySize;
    if (expandedSize > MAX_ARCHIVE_EXPANDED_SIZE) rejectUnsafeArchive();
    offset = nextOffset;
  }
  if (offset > directoryOffset + directorySize) rejectUnsafeArchive();
};

const findDirectoryEnd = (buffer: Buffer): number => {
  const minimumOffset = Math.max(0, buffer.length - 22 - 65_535);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  return rejectUnsafeArchive();
};

const rejectUnsafeArchive = (): never => {
  throw new ApplicationError(
    400,
    'UNSAFE_ARCHIVE',
    'The Office document archive is invalid or expands beyond the allowed limit.',
  );
};
