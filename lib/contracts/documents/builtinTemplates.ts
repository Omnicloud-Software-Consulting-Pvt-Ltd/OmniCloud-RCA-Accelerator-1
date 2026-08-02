/**
 * The 10 built-in document templates (§Left Sidebar "Built-in Templates") —
 * fixed HTML bodies containing {{MergeField}} tokens, immutable (never
 * editable/deletable, only duplicable into an editable custom copy). Bodies
 * use the Template Studio's recognized tag set (h1/h2/h3/p/br/strong/em/
 * ul/ol/li/table, see pdfTagConverter.ts) so they render identically in the
 * HTML/print preview and the generated PDF/DOCX out of the box.
 */
export interface BuiltinTemplateDef {
  key: string;
  name: string;
  bodyHtml: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplateDef[] = [
  {
    key: "msa",
    name: "Master Service Agreement (MSA)",
    bodyHtml:
      "<h1>Master Service Agreement</h1>" +
      "<p>This Master Service Agreement (\"Agreement\") is entered into between <strong>{{CompanyName}}</strong> and <strong>{{CustomerName}}</strong>, effective {{StartDate}}.</p>" +
      "<h2>1. Term</h2>" +
      "<p>This Agreement covers a term of {{ContractTerm}} month(s), beginning {{StartDate}} and ending {{EndDate}}, unless renewed or terminated earlier in accordance with its terms.</p>" +
      "<h2>2. Services</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>3. Contract Reference</h2>" +
      "<ul><li>Contract Number: {{ContractNumber}}</li><li>Status: {{Status}}</li></ul>" +
      "<h2>4. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "nda",
    name: "Non Disclosure Agreement (NDA)",
    bodyHtml:
      "<h1>Non-Disclosure Agreement</h1>" +
      "<p>This Non-Disclosure Agreement is entered into between <strong>{{CompanyName}}</strong> (\"Disclosing Party\") and <strong>{{CustomerName}}</strong> (\"Receiving Party\"), effective {{StartDate}}.</p>" +
      "<h2>1. Confidential Information</h2>" +
      "<p>The Receiving Party agrees to hold in strict confidence all non-public information disclosed by the Disclosing Party in connection with this Agreement.</p>" +
      "<h2>2. Term</h2>" +
      "<p>This Agreement remains in effect from {{StartDate}} through {{EndDate}}.</p>" +
      "<h2>3. Obligations</h2>" +
      "<ul><li>Use confidential information solely for the purposes of the business relationship.</li><li>Not disclose confidential information to any third party without prior written consent.</li><li>Return or destroy confidential information upon request.</li></ul>" +
      "<h2>4. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>5. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "saas-subscription",
    name: "SaaS Subscription Agreement",
    bodyHtml:
      "<h1>SaaS Subscription Agreement</h1>" +
      "<p><strong>{{CustomerName}}</strong> agrees to subscribe to the services provided by <strong>{{CompanyName}}</strong> for a term of {{ContractTerm}} month(s), effective {{StartDate}} through {{EndDate}}.</p>" +
      "<h2>1. Subscription Details</h2>" +
      "<table><tr><th>Item</th><th>Detail</th></tr>" +
      "<tr><td>Quote Reference</td><td>{{QuoteNumber}}</td></tr>" +
      "<tr><td>Products / Services</td><td>{{Products}}</td></tr>" +
      "<tr><td>Billing Frequency</td><td>{{BillingFrequency}}</td></tr>" +
      "<tr><td>Total Value</td><td>{{GrandTotal}}</td></tr></table>" +
      "<h2>2. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>3. Terms</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>4. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "software-license",
    name: "Software License Agreement",
    bodyHtml:
      "<h1>Software License Agreement</h1>" +
      "<p><strong>{{CompanyName}}</strong> (\"Licensor\") grants <strong>{{CustomerName}}</strong> (\"Licensee\") a license to use the software described below, effective {{StartDate}}.</p>" +
      "<h2>1. Grant of License</h2>" +
      "<p>Licensor grants Licensee a non-exclusive, non-transferable license to use the licensed software for the term of this Agreement, {{StartDate}} through {{EndDate}}.</p>" +
      "<h2>2. Restrictions</h2>" +
      "<ol><li>Licensee shall not sublicense, resell, or distribute the software.</li><li>Licensee shall not reverse-engineer or decompile the software.</li><li>Licensee shall comply with all applicable export control laws.</li></ol>" +
      "<h2>3. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>4. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "service",
    name: "Service Agreement",
    bodyHtml:
      "<h1>Service Agreement</h1>" +
      "<p>This Service Agreement is made between <strong>{{CompanyName}}</strong> and <strong>{{CustomerName}}</strong>, effective {{StartDate}}.</p>" +
      "<h2>1. Scope of Services</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>2. Term</h2>" +
      "<p>{{StartDate}} through {{EndDate}} ({{ContractTerm}} month(s)).</p>" +
      "<h2>3. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>4. Acceptance</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "support",
    name: "Support Agreement",
    bodyHtml:
      "<h1>Support Agreement</h1>" +
      "<p>This Support Agreement between <strong>{{CompanyName}}</strong> and <strong>{{CustomerName}}</strong> is effective {{StartDate}} and remains in effect through {{EndDate}}.</p>" +
      "<h2>1. Coverage</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}<br/>Term: {{ContractTerm}} month(s)</p>" +
      "<h2>2. Scope of Support</h2>" +
      "<ul><li>Standard business-hours technical support.</li><li>Bug fixes and patch releases for the covered products.</li><li>Escalation path for critical issues.</li></ul>" +
      "<h2>3. Notes</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>4. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "consulting",
    name: "Consulting Agreement",
    bodyHtml:
      "<h1>Consulting Agreement</h1>" +
      "<p>This Consulting Agreement is entered into between <strong>{{CompanyName}}</strong> (\"Consultant\") and <strong>{{CustomerName}}</strong> (\"Client\"), effective {{StartDate}}.</p>" +
      "<h2>1. Services</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>2. Term</h2>" +
      "<p>{{StartDate}} through {{EndDate}}.</p>" +
      "<h2>3. Fees</h2>" +
      "<p>Total Value: {{GrandTotal}}<br/>Billing Frequency: {{BillingFrequency}}</p>" +
      "<h2>4. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>5. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "maintenance",
    name: "Maintenance Agreement",
    bodyHtml:
      "<h1>Maintenance Agreement</h1>" +
      "<p>This Maintenance Agreement between <strong>{{CompanyName}}</strong> and <strong>{{CustomerName}}</strong> covers ongoing maintenance services effective {{StartDate}} through {{EndDate}}.</p>" +
      "<h2>1. Maintenance Scope</h2>" +
      "<ul><li>Scheduled preventive maintenance.</li><li>Emergency repair response.</li><li>Parts and labor as specified in the order referenced below.</li></ul>" +
      "<h2>2. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Quote Reference: {{QuoteNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>3. Notes</h2>" +
      "<p>{{Description}}</p>" +
      "<h2>4. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "purchase",
    name: "Purchase Agreement",
    bodyHtml:
      "<h1>Purchase Agreement</h1>" +
      "<p>This Purchase Agreement is made between <strong>{{CompanyName}}</strong> (\"Seller\") and <strong>{{CustomerName}}</strong> (\"Buyer\"), effective {{StartDate}}.</p>" +
      "<h2>1. Products Purchased</h2>" +
      "<table><tr><th>Item</th><th>Detail</th></tr>" +
      "<tr><td>Products</td><td>{{Products}}</td></tr>" +
      "<tr><td>Quote Reference</td><td>{{QuoteNumber}}</td></tr>" +
      "<tr><td>Total Value</td><td>{{GrandTotal}}</td></tr>" +
      "<tr><td>Payment Terms</td><td>{{PaymentTerms}}</td></tr></table>" +
      "<h2>2. Reference</h2>" +
      "<p>Contract Number: {{ContractNumber}}<br/>Status: {{Status}}</p>" +
      "<h2>3. Signatures</h2>" +
      "<p>Authorized Signer: {{AuthorizedSigner}}<br/>Company Signed Date: {{CompanySignedDate}}<br/>Customer Signed Date: {{CustomerSignedDate}}</p>",
  },
  {
    key: "blank",
    name: "Custom Blank Template",
    bodyHtml:
      "<h1>{{CompanyName}}</h1>" +
      "<p>Start typing to draft this agreement for <strong>{{CustomerName}}</strong>. Insert merge fields from the toolbar and format using the editor above.</p>" +
      "<h2>Section 1</h2>" +
      "<p></p>",
  },
];
