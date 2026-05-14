/**
 * Public domain types for the DSGo app bridge.
 *
 * These were extracted verbatim from client.ts to keep that file focused on
 * transport wiring and the `dsgo` API surface. client.ts re-exports every
 * name here, so the package's public type surface (and the rollup `.d.ts`
 * output) is unchanged.
 */

export type PostStatus = 'publish' | 'draft' | 'private' | 'pending' | 'future' | 'any';

export interface PostsQuery {
  /**
   * Custom post type slug. When omitted, queries the default `post` post type.
   * The post type must be public and `show_in_rest`; the server enforces the
   * same visibility and capability rules it would for any other REST consumer.
   * Example: `dsgo.posts.list({ type: 'recipe', per_page: 10 })`.
   */
  type?: string;
  per_page?: number;
  page?: number;
  search?: string;
  category?: number | string;
  tag?: number | string;
  orderby?: 'date' | 'modified' | 'title' | 'id';
  order?: 'asc' | 'desc';
  status?: PostStatus;
}

/**
 * Block + theme stylesheets the host attaches to a post when its app's
 * manifest opts in via `content.blockStyles` / `content.themeStyles`.
 * Apps render the styles by calling `applyBlockStyles(post.content_styles)`
 * (or letting the SDK helper handle it). Always null when the manifest
 * doesn't opt in.
 */
export interface PostContentStyles {
  /** Absolute URLs of <link rel="stylesheet"> sheets to inject. */
  links: string[];
  /** Concatenated inline CSS to drop into a <style> block. */
  inline: string;
  /** Resolved sources, e.g. ["core","designsetgo","auto","theme:global"]. */
  sources: string[];
  /** Byte accounting; `used` may be less than the raw concatenation when the cap kicked in. */
  budget: { used: number; cap: number };
}

export interface Post {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  /** Optional sibling — present only when the manifest opts in. */
  content_styles: PostContentStyles | null;
  status: PostStatus;
  protected: boolean;
  date: string;
  modified: string;
  author: number;
  link: string;
  featured_media_url: string | null;
  categories: number[];
  tags: number[];
}

export interface PostListResult { items: Post[]; total: number; total_pages: number }

export interface SiteInfo {
  title: string;
  description: string;
  url: string;
  admin_email: string;
  language: string;
  timezone: string;
  gmt_offset: number;
  date_format: string;
  time_format: string;
}

export interface EmailSendParams {
  to: 'admin' | 'current_user';
  subject: string;
  body: string;
  isHtml?: boolean;
  replyTo?: string;
}

export interface EmailSendResult { sent: true }

export interface MediaUploadOptions {
  /** Override the filename used for the WP attachment. Sanitized server-side. */
  filename?: string;
  /** Sets the attachment's alt text (`_wp_attachment_image_alt` meta). */
  altText?: string;
}

export interface MediaUploadResult {
  /** WP attachment post ID. */
  id: number;
  /** Public URL of the uploaded file (under `wp-content/uploads/...`). */
  url: string;
  /** Final MIME type of the stored file, as detected by WordPress. */
  mime_type: string;
  /** Final on-disk filename (after collision resolution). */
  filename: string;
  /** Image width in pixels, or null for non-rasterized formats (e.g. SVG). */
  width: number | null;
  /** Image height in pixels, or null for non-rasterized formats. */
  height: number | null;
  /** Alt text saved against the attachment, or `""` when none was supplied. */
  alt_text: string;
}

export interface CurrentUser {
  id: number;
  name: string;
  slug: string;
  email: string;
  avatar_url: string;
  roles: string[];
}

// ---------------------------------------------------------------------------
// Commerce surface — abilities-first with REST fallback to dsgo.commerce.*
// ---------------------------------------------------------------------------

export interface CommerceProductAttributeTerm {
  id: number;
  name: string;
  slug: string;
}

export interface CommerceProductAttribute {
  id: number;
  name: string;
  taxonomy: string;
  has_variations: boolean;
  terms: CommerceProductAttributeTerm[];
}

export interface CommerceProductVariationRef {
  id: number;
  attributes: { name: string; value: string }[];
}

export interface CommerceProductTaxonomyRef {
  id: number;
  name: string;
  slug: string;
  link: string;
}

export interface CommerceQuantityLimits {
  minimum: number;
  maximum: number;
  multiple_of: number;
  editable: boolean;
}

export interface CommerceProduct {
  id: number;
  /** Parent product id when this product is a variation child; `0` otherwise. */
  parent_id: number;
  name: string;
  slug: string;
  permalink: string;
  description: string;
  short_description: string;
  sku: string;
  price: { amount: string; regular: string; sale: string; currency: string; min: string | null; max: string | null; minor_unit: number };
  on_sale: boolean;
  is_in_stock: boolean;
  is_purchasable: boolean;
  /** Units left when stock is low; `null` when not tracked or above the threshold. */
  low_stock_remaining: number | null;
  sold_individually: boolean;
  images: { id: number; src: string; thumbnail: string; alt: string }[];
  /** WC product type: `'simple' | 'variable' | 'variation' | 'grouped' | 'external'` etc. */
  type: string;
  /** True when the product needs additional input (e.g. variable products with attributes). */
  has_options: boolean;
  /** Attribute axes the visitor must pick to add a variable product to the cart. */
  attributes: CommerceProductAttribute[];
  /** Lightweight refs to each variation. Fetch full price/stock with `products.list({ type: 'variation', parent: id })`. */
  variations: CommerceProductVariationRef[];
  categories: CommerceProductTaxonomyRef[];
  tags: CommerceProductTaxonomyRef[];
  average_rating: string;
  review_count: number;
  quantity_limits: CommerceQuantityLimits | null;
  add_to_cart: Record<string, unknown> | null;
}

export interface CommerceProductsQuery {
  page?: number;
  per_page?: number;
  search?: string;
  category?: number | string;
  tag?: number | string;
  min_price?: string | number;
  max_price?: string | number;
  orderby?: 'date' | 'price' | 'popularity' | 'rating' | 'title' | 'menu_order';
  order?: 'asc' | 'desc';
  on_sale?: boolean;
  featured?: boolean;
  /** Set to `'variation'` together with `parent` to fetch children of a variable product. */
  type?: 'simple' | 'variable' | 'variation' | 'grouped' | 'external';
  /** Parent product id; pair with `type: 'variation'` to fetch fully-priced variation children. */
  parent?: number;
  include?: number[];
  exclude?: number[];
  slug?: string;
  sku?: string;
  stock_status?: 'instock' | 'outofstock' | 'onbackorder';
}

export interface CommerceProductsResult { items: CommerceProduct[]; total: number; total_pages: number }

export interface CommerceCartItem {
  key: string;
  id: number;
  name: string;
  quantity: number;
  permalink: string;
  image: string;
  totals: Record<string, unknown> | null;
}

export interface CommerceCart {
  items: CommerceCartItem[];
  items_count: number;
  items_weight: number;
  totals: { total_items: string; total_price: string; currency_code: string; currency_minor_unit: number };
  needs_shipping: boolean;
  needs_payment: boolean;
}

export interface CheckoutHostedResult { url: string; navigated: boolean }
