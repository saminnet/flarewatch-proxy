export interface MonitorTarget {
  id: string;
  name: string;
  method: string;
  target: string;
  expectedCodes?: number[] | undefined;
  timeout?: number | undefined;
  headers?: Record<string, string | number> | undefined;
  body?: string | undefined;
  responseKeyword?: string | undefined;
  responseForbiddenKeyword?: string | undefined;
  /** A `$.a.b[0].c` path into the JSON body whose value must equal `responseJsonValue`. */
  responseJsonPath?: string | undefined;
  responseJsonValue?: string | number | boolean | null | undefined;
  /** Header names ignore case; values must match exactly. */
  responseHeaderEquals?: Record<string, string> | undefined;
  sslCheckEnabled?: boolean | undefined;
  sslCheckDaysBeforeExpiry?: number | undefined;
  sslIgnoreSelfSigned?: boolean | undefined;
}

export interface SSLCertificateInfo {
  expiryDate: number;
  daysUntilExpiry: number;
  issuer?: string | undefined;
  subject?: string | undefined;
}

export interface CheckSuccess {
  ok: true;
  latency: number;
  ssl?: SSLCertificateInfo;
}

export interface CheckFailure {
  ok: false;
  error: string;
  latency?: number;
}

export type CheckResult = CheckSuccess | CheckFailure;

export interface CheckResultWithLocation {
  contract: number;
  location: string;
  result: CheckResult;
}

export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
