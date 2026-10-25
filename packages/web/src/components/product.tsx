import { Icon } from "./icon";
import { ProductPreview } from "./product-preview";

export function Product() {
  return <section className="product-section" id="product" aria-labelledby="product-title" tabIndex={-1}>
    <div className="site-container product-layout">
      <div className="product-copy">
        <p className="product-eyebrow">Product<span aria-hidden="true"/></p>
        <h2 id="product-title">A complete webhook<br className="product-heading-break"/> delivery platform.</h2>
        <p className="product-description">Waybill helps you build reliable integrations by handling the hard parts of webhook delivery, so you can focus on your product.</p>
        <a className="button button-primary product-cta" href="/#how-it-works">Explore product <Icon name="arrow"/></a>
      </div>
      <ProductPreview/>
    </div>
  </section>;
}
