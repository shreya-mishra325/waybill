import { DocsArticle } from "../../components/docs/article";
import { DOC_TOPICS } from "../../lib/docs";

export default function Documentation() {
  return <DocsArticle topic={DOC_TOPICS[0]}/>;
}
