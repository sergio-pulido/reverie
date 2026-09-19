import type { CatalogueTitle } from "../catalogue/contract";

/**
 * A title's poster. The width and height give the image its 2:3 box before it loads, so a poster
 * arriving never moves anything around it. A title without one says so instead of showing a
 * blank.
 */
export function Artwork({ title, className = "discover-card-art" }: { title: CatalogueTitle; className?: string }) {
  if (!title.posterUrl) {
    return (
      <span className={`${className} ${className}-empty`} aria-hidden="true">
        No artwork supplied
      </span>
    );
  }
  return (
    <img
      className={className}
      src={title.posterUrl}
      alt={`Poster for ${title.title}`}
      width={500}
      height={750}
      loading="lazy"
      decoding="async"
    />
  );
}
