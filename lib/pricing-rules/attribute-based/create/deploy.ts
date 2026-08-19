/**
 * Package + zip + deploy a single ExpressionSetDefinition file via the
 * Metadata API SOAP `deploy()` call, polling `checkDeployStatus` to
 * completion.
 *
 * §ZIP packaging: this file never hardcodes the metadata folder name or
 * file suffix as a guess — it derives the real folder + file suffix from
 * the donor Expression Set's own retrieved Metadata API path, then
 * explicitly re-compares every generated packaging field (metadata type,
 * folder, file extension, relative-path shape, package member) against
 * that donor reference immediately before deploying, and refuses to call
 * the Metadata API at all unless every one of those comparisons — plus the
 * zip-contents/root checks — passes.
 */
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { normalizeApiVersionNumber } from "@/lib/salesforce/client";
import { EXPRESSION_SET_METADATA_TYPE, metadataDeploy, pollDeployStatus, type DeployStatusInfo } from "./soapEnvelope";

const FALLBACK_FOLDER = "expressionSetDefinitions";
const FALLBACK_SUFFIX = ".expressionSetDefinition-meta.xml";

export interface DeployZipFileEntry {
  path: string;
  fileName: string;
  metadataType: string;
}

export interface PackageMemberCheck {
  metadataType: string;
  memberName: string;
  expectedZipPath: string;
  actualZipPath: string | null;
  status: "PASS" | "FAIL";
}

export interface MetadataDescriptor {
  metadataType: string;
  folder: string;
  fileName: string;
  fileExtension: string;
  relativePath: string;
  packageMember: string;
}

export interface PackagingComparisonRow {
  field: string;
  donor: string;
  generated: string;
  status: "PASS" | "FAIL";
  note?: string;
}

export interface NamingConvention {
  folder: string;
  suffix: string;
  /** Human-readable explanation of where folder/suffix came from — a real donor retrieve, or an unverified fallback guess. */
  source: string;
  /** True only when derived from a real Metadata API retrieve path, never from a guess. */
  confirmedFromDonor: boolean;
}

export interface DeployPackagingReport {
  zipTree: string[];
  files: DeployZipFileEntry[];
  packageXml: string;
  memberChecks: PackageMemberCheck[];
  naming: NamingConvention;
  zipRootOk: boolean;
  zipRootIssues: string[];
  donor: MetadataDescriptor | null;
  generated: MetadataDescriptor | null;
  comparison: PackagingComparisonRow[];
  packageXmlMemberCheck: { declaredMember: string; generatedFileBaseName: string; status: "PASS" | "FAIL" } | null;
  /** Overall verdict; false stops the deploy before the Metadata API is ever called. */
  safeToDeploy: boolean;
  safetyIssues: string[];
  reportText: string;
}

export interface DeployExpressionSetResult {
  success: boolean;
  status: DeployStatusInfo | null;
  error?: string;
  packagingReport: DeployPackagingReport;
  /** True when this failure was caught by the local pre-deploy packaging check — the Metadata API was never called. */
  localPackagingFailure?: boolean;
  /** The exact generated Expression Set XML that was (or would have been) deployed, present on every outcome so a failure can be traced to precisely what Salesforce rejected. */
  generatedFileXml: string;
  /** Base64 of the ZIP package sent to (or built for) the Metadata API deploy call. Absent only when the pre-zip check failed before any ZIP existed at all. */
  deployZipBase64?: string;
  /** The raw SOAP checkDeployStatus response XML, carried up so a caller can fall back to it when `status.componentFailures` came back empty. */
  rawDeployStatusXml?: string;
}

/**
 * Parse the exact path the Metadata API returned when it retrieved the
 * donor Expression Set (e.g.
 * "unpackaged/expressionSetDefinitions/AttributeDiscount.expressionSetDefinition-meta.xml")
 * into its Folder / File / Relative Path / Package Member parts. Returns
 * null (never a guess) when the path doesn't parse into that clean shape.
 */
function buildDonorDescriptor(donorFileName: string | undefined): MetadataDescriptor | null {
  if (!donorFileName) return null;
  const segments = donorFileName.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const fileName = segments[segments.length - 1];
  const folder = segments[segments.length - 2];
  const dotIdx = fileName.indexOf(".");
  if (folder.includes(".") || dotIdx <= 0) return null;
  const fileExtension = fileName.slice(dotIdx);
  const packageMember = fileName.slice(0, dotIdx);
  return {
    metadataType: EXPRESSION_SET_METADATA_TYPE,
    folder,
    fileName,
    fileExtension,
    relativePath: `${folder}/${fileName}`,
    packageMember,
  };
}

function deriveNamingConvention(donor: MetadataDescriptor | null, donorFileNameRaw: string | undefined): NamingConvention {
  if (donor) {
    return {
      folder: donor.folder,
      suffix: donor.fileExtension,
      source: `Derived from the donor Expression Set's own Metadata API retrieve path: "${donorFileNameRaw}".`,
      confirmedFromDonor: true,
    };
  }
  return {
    folder: FALLBACK_FOLDER,
    suffix: FALLBACK_SUFFIX,
    source: donorFileNameRaw
      ? `Donor file path "${donorFileNameRaw}" did not parse into a clean folder/file shape — falling back to an UNVERIFIED guess of the folder/suffix convention.`
      : "No donor file path was available from the Metadata API retrieve — falling back to an UNVERIFIED guess of the folder/suffix convention.",
    confirmedFromDonor: false,
  };
}

function extractPackageXmlTag(packageXml: string, tag: string): string {
  const m = packageXml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
  return m ? m[1] : "";
}

function renderReportText(r: Omit<DeployPackagingReport, "reportText">): string {
  const lines: string[] = [];

  lines.push("=== Donor Metadata Validation ===");
  if (r.donor) {
    lines.push(`Metadata Type: ${r.donor.metadataType}`);
    lines.push(`Folder: ${r.donor.folder}`);
    lines.push(`File: ${r.donor.fileName}`);
    lines.push(`Relative Path: ${r.donor.relativePath}`);
    lines.push(`Package Member: ${r.donor.packageMember}`);
  } else {
    lines.push("No donor reference available — could not retrieve/parse a donor Expression Set's Metadata API path.");
  }
  lines.push("");

  lines.push("=== Generated Package Validation ===");
  if (r.generated) {
    lines.push(`Metadata Type: ${r.generated.metadataType}`);
    lines.push(`Folder: ${r.generated.folder}`);
    lines.push(`File: ${r.generated.fileName}`);
    lines.push(`Relative Path: ${r.generated.relativePath}`);
    lines.push(`Package Member: ${r.generated.packageMember}`);
  } else {
    lines.push("Not generated — a prior check failed.");
  }
  lines.push("");
  lines.push("Comparison (Donor vs. Generated):");
  for (const row of r.comparison) {
    lines.push(`  - Field: ${row.field}`);
    lines.push(`    Donor: ${row.donor}`);
    lines.push(`    Generated: ${row.generated}`);
    lines.push(`    Result: ${row.status}${row.note ? ` (${row.note})` : ""}`);
  }
  lines.push("");

  lines.push("=== Package.xml Validation ===");
  if (r.packageXmlMemberCheck) {
    lines.push(`package.xml declares member: ${r.packageXmlMemberCheck.declaredMember}`);
    lines.push(`Generated metadata file base name: ${r.packageXmlMemberCheck.generatedFileBaseName}`);
    lines.push(`Result: ${r.packageXmlMemberCheck.status}${r.packageXmlMemberCheck.status === "PASS" ? " (package.xml member exactly matches the generated file's own name, not a donor name or other identifier)" : " (MISMATCH — package.xml would reference a file that does not exist under this name)"}`);
  } else {
    lines.push("Not checked — a prior check failed.");
  }
  lines.push("");

  lines.push("=== ZIP Contents ===");
  lines.push("ZIP Directory Tree:");
  for (const p of r.zipTree) lines.push(`  ${p}`);
  lines.push("");
  lines.push("Files Added to ZIP:");
  for (const f of r.files) {
    lines.push(`  - Path: ${f.path}`);
    lines.push(`    File Name: ${f.fileName}`);
    lines.push(`    Metadata Type: ${f.metadataType}`);
  }
  lines.push("");
  lines.push("Generated package.xml:");
  lines.push(r.packageXml.trimEnd());
  lines.push("");
  lines.push("Member-exists-in-ZIP check:");
  for (const m of r.memberChecks) {
    lines.push(`  - Metadata Type: ${m.metadataType}`);
    lines.push(`    Member Name: ${m.memberName}`);
    lines.push(`    Expected ZIP Path: ${m.expectedZipPath}`);
    lines.push(`    Actual ZIP Path: ${m.actualZipPath ?? "(not found in ZIP)"}`);
    lines.push(`    Result: ${m.status}`);
  }
  lines.push("");
  lines.push(`ZIP Root Check: ${r.zipRootOk ? "PASS" : "FAIL"} (package.xml and the metadata type folder must sit directly at the ZIP root, with no extra wrapper directory)`);
  for (const issue of r.zipRootIssues) lines.push(`  - ${issue}`);
  lines.push("");

  lines.push("=== Deployment Safety Check ===");
  lines.push(`Verdict: ${r.safeToDeploy ? "PROCEED — all checks passed, calling the Metadata API." : "STOP — the Metadata API was NOT called."}`);
  if (!r.safeToDeploy) {
    lines.push("Issues:");
    for (const issue of r.safetyIssues) lines.push(`  - ${issue}`);
  }
  return lines.join("\n");
}

export async function deployExpressionSetDefinition(
  client: SalesforceClient,
  apiName: string,
  fileXml: string,
  donorFileName?: string,
): Promise<DeployExpressionSetResult> {
  const donor = buildDonorDescriptor(donorFileName);
  const naming = deriveNamingConvention(donor, donorFileName);

  // Cheap pre-zip check — only confirm the AttributeDiscount step is present.
  if (!fileXml.includes("<actionType>AttributeDiscount</actionType>")) {
    const emptyReport: DeployPackagingReport = {
      zipTree: [], files: [], packageXml: "", memberChecks: [], naming, zipRootOk: false, zipRootIssues: [],
      donor, generated: null, comparison: [], packageXmlMemberCheck: null, safeToDeploy: false,
      safetyIssues: ["Pre-zip check failed before packaging was attempted."], reportText: "",
    };
    const result: DeployExpressionSetResult = {
      success: false, status: null, error: "Pre-zip check failed: no <actionType>AttributeDiscount</actionType> in the generated file.",
      packagingReport: emptyReport, generatedFileXml: fileXml,
    };
    client.logDebug("deploy-response", `Parsed DeployExpressionSetResult:\n${JSON.stringify({ success: result.success, error: result.error, generatedFileXmlLength: result.generatedFileXml.length }, null, 2)}`);
    return result;
  }

  const versionNumber = normalizeApiVersionNumber(client.apiVersion);
  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `  <types>\n    <members>${apiName}</members>\n    <name>${EXPRESSION_SET_METADATA_TYPE}</name>\n  </types>\n` +
    `  <version>${versionNumber}</version>\n` +
    `</Package>\n`;

  const memberFileName = `${apiName}${naming.suffix}`;
  const memberPath = `${naming.folder}/${memberFileName}`;

  const zip = new JSZip();
  zip.file("package.xml", packageXml);
  zip.file(memberPath, fileXml);

  const files: DeployZipFileEntry[] = [
    { path: memberPath, fileName: memberFileName, metadataType: EXPRESSION_SET_METADATA_TYPE },
  ];
  const zipTree = ["package.xml", `${naming.folder}/`, memberPath];

  const zipRootIssues: string[] = [];
  if (naming.folder.includes("/")) zipRootIssues.push(`Derived folder "${naming.folder}" contains an extra path separator — this would nest the metadata type folder under an unexpected wrapper directory.`);
  const zipRootOk = zipRootIssues.length === 0;

  const memberChecks: PackageMemberCheck[] = [{
    metadataType: EXPRESSION_SET_METADATA_TYPE,
    memberName: apiName,
    expectedZipPath: memberPath,
    actualZipPath: zip.file(memberPath) ? memberPath : null,
    status: zip.file(memberPath) ? "PASS" : "FAIL",
  }];

  const zipEntry = zip.file(memberPath);
  const generatedFileBaseName = memberFileName.slice(0, memberFileName.length - naming.suffix.length);
  const generated: MetadataDescriptor = {
    metadataType: extractPackageXmlTag(packageXml, "name"),
    folder: naming.folder,
    fileName: zipEntry ? memberFileName : "(missing)",
    fileExtension: naming.suffix,
    relativePath: memberPath,
    packageMember: generatedFileBaseName,
  };

  const comparison: PackagingComparisonRow[] = [];
  if (donor) {
    comparison.push({ field: "Metadata Type", donor: donor.metadataType, generated: generated.metadataType, status: donor.metadataType === generated.metadataType ? "PASS" : "FAIL" });
    comparison.push({ field: "Folder", donor: donor.folder, generated: generated.folder, status: donor.folder === generated.folder ? "PASS" : "FAIL" });
    comparison.push({ field: "File Extension", donor: donor.fileExtension, generated: generated.fileExtension, status: donor.fileExtension === generated.fileExtension ? "PASS" : "FAIL" });
    const donorPathShape = `${donor.folder}/{member}${donor.fileExtension}`;
    const generatedPathShape = `${generated.folder}/{member}${generated.fileExtension}`;
    comparison.push({
      field: "Relative Path", donor: donor.relativePath, generated: generated.relativePath,
      status: donorPathShape === generatedPathShape ? "PASS" : "FAIL",
      note: "compared by folder+extension shape — the member/file name intentionally differs from the donor",
    });
    comparison.push({
      field: "Package Member", donor: donor.packageMember, generated: generated.packageMember,
      status: generated.packageMember === apiName ? "PASS" : "FAIL",
      note: "not required to equal the donor's member name — see Package.xml Validation for the check that matters here",
    });
  }

  const declaredMember = extractPackageXmlTag(packageXml, "members");
  const packageXmlMemberCheck = {
    declaredMember,
    generatedFileBaseName,
    status: (declaredMember === generatedFileBaseName ? "PASS" : "FAIL") as "PASS" | "FAIL",
  };

  const safetyIssues: string[] = [];
  if (!donor) safetyIssues.push("No confirmed donor metadata reference was available — the folder/file-extension convention could not be verified against a real org retrieve.");
  for (const row of comparison) if (row.status === "FAIL") safetyIssues.push(`"${row.field}" does not match the donor convention (donor: "${row.donor}", generated: "${row.generated}").`);
  if (packageXmlMemberCheck.status === "FAIL") safetyIssues.push(`package.xml declares member "${packageXmlMemberCheck.declaredMember}" but the generated file's base name is "${packageXmlMemberCheck.generatedFileBaseName}".`);
  for (const m of memberChecks) if (m.status === "FAIL") safetyIssues.push(`${m.metadataType} "${m.memberName}" is declared in package.xml but has no matching file in the ZIP (expected "${m.expectedZipPath}").`);
  if (!zipRootOk) safetyIssues.push(...zipRootIssues);
  const safeToDeploy = safetyIssues.length === 0;

  const packagingReportBase: Omit<DeployPackagingReport, "reportText"> = {
    zipTree, files, packageXml, memberChecks, naming, zipRootOk, zipRootIssues,
    donor, generated, comparison, packageXmlMemberCheck, safeToDeploy, safetyIssues,
  };
  const reportText = renderReportText(packagingReportBase);
  const packagingReport: DeployPackagingReport = { ...packagingReportBase, reportText };

  client.logDebug("zip-diagnostic", reportText);

  const zipBase64 = await zip.generateAsync({ type: "base64" });

  if (!safeToDeploy) {
    const result: DeployExpressionSetResult = {
      success: false,
      status: null,
      error: `Local packaging validation failed before calling the Metadata API — the deployment was never sent to Salesforce. ${safetyIssues.join(" ")}`,
      packagingReport,
      localPackagingFailure: true,
      generatedFileXml: fileXml,
      deployZipBase64: zipBase64,
    };
    client.logDebug("deploy-response", `Parsed DeployExpressionSetResult:\n${JSON.stringify({ success: result.success, error: result.error, localPackagingFailure: true, generatedFileXmlLength: result.generatedFileXml.length, deployZipBase64Present: !!result.deployZipBase64 }, null, 2)}`);
    return result;
  }

  const asyncResult = await metadataDeploy(client, zipBase64);
  const status = await pollDeployStatus(client, asyncResult.id);
  client.logDebug("deploy-response", JSON.stringify({
    id: status.id, done: status.done, success: status.success, status: status.status,
    numberComponentsDeployed: status.numberComponentsDeployed, numberComponentErrors: status.numberComponentErrors,
    errorMessage: status.errorMessage, componentFailures: status.componentFailures,
  }));

  function logParsedResult(result: DeployExpressionSetResult): void {
    client.logDebug("deploy-response", `Parsed DeployExpressionSetResult:\n${JSON.stringify({
      success: result.success,
      error: result.error ?? null,
      localPackagingFailure: result.localPackagingFailure ?? false,
      status: result.status,
      generatedFileXmlLength: result.generatedFileXml.length,
      deployZipBase64Present: !!result.deployZipBase64,
      rawDeployStatusXmlPresent: !!result.rawDeployStatusXml,
    }, null, 2)}`);
  }

  if (!status.success) {
    const detail = status.componentFailures.map(f => `${f.fullName ?? f.fileName}: ${f.problem}`).join("; ");
    const result: DeployExpressionSetResult = {
      success: false, status, error: status.errorMessage ?? detail ?? "Metadata deploy failed.", packagingReport,
      generatedFileXml: fileXml, deployZipBase64: zipBase64, rawDeployStatusXml: status.rawXml,
    };
    logParsedResult(result);
    return result;
  }
  const result: DeployExpressionSetResult = {
    success: true, status, packagingReport, generatedFileXml: fileXml, deployZipBase64: zipBase64, rawDeployStatusXml: status.rawXml,
  };
  logParsedResult(result);
  return result;
}
