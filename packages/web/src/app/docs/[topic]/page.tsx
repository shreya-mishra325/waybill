import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsArticle } from "../../../components/docs/article";
import { DOC_TOPICS, findDocTopic } from "../../../lib/docs";

type Props = { params: Promise<{ topic: string }> };
export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_TOPICS.filter(topic => topic.slug !== "introduction").map(topic => ({ topic: topic.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const topic = findDocTopic((await params).topic);
  return {title: `${topic?.title ?? "Documentation"} | Waybill Docs`, description: topic?.description};
}

export default async function DocumentationTopic({ params }: Props) {
  const topic = findDocTopic((await params).topic);
  if (!topic || topic.slug === "introduction") notFound();
  return <DocsArticle topic={topic}/>;
}
