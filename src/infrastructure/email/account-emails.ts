import { buildEmail, type EmailBrand, type EmailContent } from './email-template';

export function buildStaffInvitationEmail(input: {
  brand: EmailBrand;
  firstName: string;
  companyName: string;
  invitationUrl: string;
}): EmailContent {
  const { productName } = input.brand;
  return buildEmail({
    brand: input.brand,
    subject: `${input.companyName} invited you to ${productName}`,
    preheader: `Accept your invitation to join ${input.companyName} and set up your ${productName} account.`,
    eyebrow: 'Team invitation',
    heading: 'Great events start with a great team.',
    greeting: input.firstName.trim() ? `Hello ${input.firstName.trim()},` : 'Hello,',
    paragraphs: [
      `You have been invited to join ${input.companyName} on ${productName}.`,
      `${productName} brings event planning and guest concierge together, helping your team keep event details organized and guests informed.`,
    ],
    details: [{ label: 'Your organization', value: input.companyName }],
    action: { label: 'Accept invitation', url: input.invitationUrl },
    afterAction:
      'Use the button above to set your password and activate your account. You can then sign in to your team’s workspace.',
    notice:
      'This invitation is intended for you. Please do not forward it. If you were not expecting it, you can ignore this email.',
    reason: `You received this email because an administrator invited you to join ${input.companyName} on ${productName}.`,
  });
}

export function buildPasswordResetEmail(input: {
  brand: EmailBrand;
  resetUrl: string;
}): EmailContent {
  const { productName } = input.brand;
  return buildEmail({
    brand: input.brand,
    subject: `Reset your ${productName} password`,
    preheader: `Use this link to choose a new password for your ${productName} account.`,
    eyebrow: 'Account security',
    heading: 'Reset your password.',
    greeting: 'Hello,',
    paragraphs: [
      `We received a request to reset the password for your ${productName} account.`,
      'Select the button below to choose a new password and get back to your workspace.',
    ],
    action: { label: 'Reset password', url: input.resetUrl },
    afterAction:
      'For your security, this link can only be used once. If it has expired, request a new link from the sign-in page.',
    notice:
      'If you did not request this, you can ignore this email. Your password will stay the same unless you complete the reset. Do not share this link.',
    reason: `You received this email because a password reset was requested for your ${productName} account.`,
  });
}
