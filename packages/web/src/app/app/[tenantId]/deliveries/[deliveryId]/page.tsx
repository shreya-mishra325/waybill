import type { Metadata } from "next";
import { DeliveryDetails } from "../../../../../components/dashboard/delivery-details";
import "./delivery-details.css";

export const metadata: Metadata = { title: "Delivery details | Waybill" };
export default function DeliveryDetailsPage() { return <DeliveryDetails/>; }
