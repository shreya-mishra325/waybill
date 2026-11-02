import type { Metadata } from "next";
import { ApiKeys } from "../../../../components/dashboard/api-keys";
import "./api-keys.css";

export const metadata: Metadata = { title: "API key management | Waybill" };
export default function ApiKeysPage() { return <ApiKeys/>; }
