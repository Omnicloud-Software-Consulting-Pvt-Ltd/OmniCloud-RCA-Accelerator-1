/**
 * Email templates for signature requests. Built-ins are fixed; custom templates are saved by the user (emailTemplateStore.ts).
 * Templates only use the allowlisted {{placeholders}} from validation.ts — they are plain text, never executed.
 */

export interface EmailTemplate { id: string; name: string; subject: string; message: string; builtIn: boolean; updatedAt: string | null }

export const BUILTIN_EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "builtin-standard",
    name: "Standard Contract Signature Request",
    subject: "Please sign: {{ContractName}}",
    message: "Hello {{RecipientName}},\n\n{{CompanyName}} has sent you {{ContractName}} (contract {{ContractNumber}}) to review and sign electronically.\n\nClick the link in this email to open the document. It only takes a few minutes.\n\nThank you,\n{{CompanyName}}",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "builtin-customer",
    name: "Customer Agreement",
    subject: "Your agreement with {{CompanyName}} is ready to sign",
    message: "Hello {{RecipientName}},\n\nThank you for choosing {{CompanyName}}. Your agreement ({{ContractName}}) is ready for your signature.\n\nPlease review the terms and sign using the link in this email. Contact us if you have any questions.\n\nKind regards,\n{{CompanyName}}",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "builtin-renewal",
    name: "Renewal Agreement",
    subject: "Renewal ready to sign: {{ContractName}}",
    message: "Hello {{RecipientName}},\n\nYour agreement with {{CompanyName}} is up for renewal. The renewal for {{AccountName}} (contract {{ContractNumber}}) is ready for your signature.\n\nPlease sign using the link in this email so your service continues without interruption.\n\nThank you,\n{{CompanyName}}",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "builtin-internal",
    name: "Internal Approval",
    subject: "Internal approval needed: {{ContractName}}",
    message: "Hi {{RecipientName}},\n\nPlease review and sign {{ContractName}} (contract {{ContractNumber}}) for {{AccountName}} so it can go to the customer.\n\nThanks!",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "builtin-custom",
    name: "Custom (start from blank)",
    subject: "",
    message: "",
    builtIn: true,
    updatedAt: null,
  },
];

export const DEFAULT_EMAIL_TEMPLATE_ID = "builtin-standard";
