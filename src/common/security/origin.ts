export const normalizeOrigin = (value: string): string => new URL(value).origin;

export const isSameOrigin = (supplied: string | undefined, configured: string): boolean => {
  if (!supplied) return false;
  try {
    return normalizeOrigin(supplied) === normalizeOrigin(configured);
  } catch {
    return false;
  }
};
