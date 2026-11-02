import type { Metadata } from "next";
import { DeadLetters } from "../../../../components/dashboard/dead-letters";
import "./dead-letters.css";

export const metadata: Metadata = { title: "Dead letters | Waybill" };
export default function DeadLettersPage() { return <DeadLetters/>; }
