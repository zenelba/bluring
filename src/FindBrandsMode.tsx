import { useMemo, useState } from "react";
import {
  FIND_BRANDS_AREAS,
  getArea,
  getBrand,
  getCategory,
} from "./lib/findBrands/catalog";
import {
  ORIGIN_LABELS,
  ORIGIN_ORDER,
  type Brand,
  type BrandArea,
  type BrandCategory,
  type BrandOrigin,
} from "./lib/findBrands/types";
import "./osebe.css";
import "./findBrands.css";

type Nav =
  | { view: "areas" }
  | { view: "area"; areaId: string }
  | { view: "category"; areaId: string; categoryId: string }
  | { view: "brand"; areaId: string; categoryId: string; brandId: string };

function brandsByOrigin(brands: ReadonlyArray<Brand>, origin: BrandOrigin) {
  return brands.filter((b) => b.origin === origin);
}

function LogoImg({ brand }: { brand: Brand }) {
  const png = brand.logoSrc;
  const svg = brand.logoSrc.replace(/\.png$/i, ".svg");
  const [src, setSrc] = useState(png);
  if (!src) {
    return (
      <span className="fb-logo-fallback" aria-hidden>
        {brand.name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="fb-logo-img"
      src={src}
      alt=""
      loading="lazy"
      onError={() => {
        if (src === png && svg !== png) setSrc(svg);
        else setSrc("");
      }}
    />
  );
}

function AreasView({ onOpen }: { onOpen: (areaId: string) => void }) {
  return (
    <div className="fb-main">
      <header className="fb-header">
        <h2>Področja</h2>
        <p>Izberi področje za pregled znamk po kategorijah.</p>
      </header>
      <div className="fb-area-grid">
        {FIND_BRANDS_AREAS.map((area) => (
          <button
            key={area.id}
            type="button"
            className="fb-area-card"
            onClick={() => onOpen(area.id)}
          >
            <span className="fb-area-card__title">{area.title}</span>
            <span className="fb-area-card__blurb">{area.blurb}</span>
            <span className="fb-area-card__meta">
              {area.categories.length} kategorij ·{" "}
              {area.categories.reduce((n, c) => n + c.brands.length, 0)} znamk
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AreaView({
  area,
  onBack,
  onOpenCategory,
}: {
  area: BrandArea;
  onBack: () => void;
  onOpenCategory: (categoryId: string) => void;
}) {
  return (
    <div className="fb-main">
      <header className="fb-header">
        <button type="button" className="fb-back" onClick={onBack}>
          ← Področja
        </button>
        <h2>{area.title}</h2>
        <p>{area.blurb}</p>
      </header>
      <ol className="fb-cat-list">
        {area.categories.map((cat) => (
          <li key={cat.id}>
            <button
              type="button"
              className="fb-cat-row"
              onClick={() => onOpenCategory(cat.id)}
            >
              <span className="fb-cat-row__num">
                {String(cat.number).padStart(2, "0")}
              </span>
              <span className="fb-cat-row__body">
                <span className="fb-cat-row__title">{cat.title}</span>
                <span className="fb-cat-row__meta">
                  {cat.brands.length} znamk
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CategoryView({
  area,
  category,
  onBack,
  onOpenBrand,
}: {
  area: BrandArea;
  category: BrandCategory;
  onBack: () => void;
  onOpenBrand: (brandId: string) => void;
}) {
  return (
    <div className="fb-main">
      <header className="fb-header">
        <button type="button" className="fb-back" onClick={onBack}>
          ← {area.title}
        </button>
        <p className="fb-kicker">
          Kategorija {String(category.number).padStart(2, "0")}
        </p>
        <h2>{category.title}</h2>
        <p>Klikni logotip za interni pregled zbranih podatkov.</p>
      </header>

      {ORIGIN_ORDER.map((origin) => {
        const list = brandsByOrigin(category.brands, origin);
        if (list.length === 0) return null;
        return (
          <section key={origin} className="fb-origin-section">
            <h3 className="fb-origin-title">{ORIGIN_LABELS[origin]}</h3>
            <div className="fb-logo-grid">
              {list.map((brand) => (
                <button
                  key={brand.id}
                  type="button"
                  className="fb-logo-card"
                  onClick={() => onOpenBrand(brand.id)}
                  aria-label={brand.name}
                  title={brand.name}
                >
                  <span className="fb-logo-frame">
                    <LogoImg key={brand.id} brand={brand} />
                  </span>
                  <span className="fb-logo-name">{brand.name}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="fb-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function BrandDetailView({
  area,
  category,
  brand,
  onBack,
}: {
  area: BrandArea;
  category: BrandCategory;
  brand: Brand;
  onBack: () => void;
}) {
  const p = brand.profile;
  return (
    <div className="fb-main fb-main--detail">
      <header className="fb-header">
        <button type="button" className="fb-back" onClick={onBack}>
          ← {category.title}
        </button>
        <div className="fb-detail-hero">
          <span className="fb-detail-logo">
            <LogoImg key={brand.id} brand={brand} />
          </span>
          <div>
            <p className="fb-kicker">
              {area.title} · {ORIGIN_LABELS[brand.origin]}
            </p>
            <h2>{brand.name}</h2>
            <p className="fb-detail-usp">{brand.usp}</p>
          </div>
        </div>
      </header>

      <div className="fb-link-row">
        <a
          className="fb-ext-link"
          href={brand.companyUrl}
          target="_blank"
          rel="noreferrer"
        >
          Glavno podjetje ↗
        </a>
        {brand.sloveniaUrl ? (
          <a
            className="fb-ext-link"
            href={brand.sloveniaUrl}
            target="_blank"
            rel="noreferrer"
          >
            Zastopnik / SLO ↗
          </a>
        ) : (
          <span className="fb-ext-link fb-ext-link--muted">
            SLO zastopnik: ni znan / ni relevantno
          </span>
        )}
      </div>

      <dl className="fb-summary">
        <Field label="Cenovni razred" value={brand.priceTier} />
        <Field label="Prisotnost v SLO" value={brand.presenceSi} />
      </dl>

      <section className="fb-section">
        <h3>1. Osnovna osebna izkaznica</h3>
        <dl className="fb-dl">
          <Field label="Uradno ime" value={p.identity.legalName} />
          <Field label="Sedež" value={p.identity.hq} />
          <Field label="Ustanovitev" value={p.identity.founded} />
          <Field label="Lastništvo" value={p.identity.ownership} />
        </dl>
      </section>

      <section className="fb-section">
        <h3>2. Poslovno-finančni profil</h3>
        <dl className="fb-dl">
          <Field label="Prihodki" value={p.finance.revenue} />
          <Field label="Zaposleni" value={p.finance.employees} />
          <Field label="Izvoz / globalna prisotnost" value={p.finance.exportShare} />
        </dl>
      </section>

      <section className="fb-section">
        <h3>3. Produktni fokus in tehnologija</h3>
        <dl className="fb-dl">
          <Field label="Linije in materiali" value={p.product.lines} />
          <Field label="Certifikati / tehnologija" value={p.product.techCerts} />
          <Field label="Proizvodni model" value={p.product.productionModel} />
        </dl>
      </section>

      <section className="fb-section">
        <h3>4. Tržno pozicioniranje</h3>
        <dl className="fb-dl">
          <Field label="Cenovni segment" value={p.positioning.priceTier} />
          <Field label="USP" value={p.positioning.usp} />
          <Field label="Ciljna skupina" value={p.positioning.target} />
        </dl>
      </section>

      <section className="fb-section">
        <h3>5. Prisotnost in distribucija v Sloveniji</h3>
        <dl className="fb-dl">
          <Field label="Model vstopa" value={p.distributionSi.entryModel} />
          <Field label="Partnerji / trgovine" value={p.distributionSi.partners} />
        </dl>
      </section>
    </div>
  );
}

export default function FindBrandsMode() {
  const [nav, setNav] = useState<Nav>({ view: "areas" });

  const area = useMemo(() => {
    if (nav.view === "areas") return null;
    return getArea(nav.areaId);
  }, [nav]);

  const category = useMemo(() => {
    if (nav.view !== "category" && nav.view !== "brand") return null;
    return getCategory(nav.areaId, nav.categoryId);
  }, [nav]);

  const brand = useMemo(() => {
    if (nav.view !== "brand") return null;
    return getBrand(nav.areaId, nav.categoryId, nav.brandId);
  }, [nav]);

  const sideTitle =
    nav.view === "areas"
      ? "Find Brands"
      : nav.view === "area"
        ? area?.title ?? "Področje"
        : nav.view === "category"
          ? category?.title ?? "Kategorija"
          : brand?.name ?? "Znamka";

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Find Brands</h2>
            <p>
              Predpripravljene znamke po področjih — logotipi, URLji in raziskava.
            </p>
          </div>

          <div className="osebe-field">
            <span className="osebe-kicker">Trenutno</span>
            <p className="fb-side-current">{sideTitle}</p>
          </div>

          {nav.view !== "areas" && (
            <button
              type="button"
              className="btn btn--ghost fb-side-home"
              onClick={() => setNav({ view: "areas" })}
            >
              Vsa področja
            </button>
          )}

          {area && (
            <nav className="fb-side-nav" aria-label="Kategorije">
              <span className="osebe-kicker">Kategorije</span>
              <ul>
                {area.categories.map((cat) => (
                  <li key={cat.id}>
                    <button
                      type="button"
                      className={
                        category?.id === cat.id
                          ? "fb-side-link fb-side-link--active"
                          : "fb-side-link"
                      }
                      onClick={() =>
                        setNav({
                          view: "category",
                          areaId: area.id,
                          categoryId: cat.id,
                        })
                      }
                    >
                      {String(cat.number).padStart(2, "0")}. {cat.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </aside>

        {nav.view === "areas" && (
          <AreasView onOpen={(areaId) => setNav({ view: "area", areaId })} />
        )}
        {nav.view === "area" && area && (
          <AreaView
            area={area}
            onBack={() => setNav({ view: "areas" })}
            onOpenCategory={(categoryId) =>
              setNav({ view: "category", areaId: area.id, categoryId })
            }
          />
        )}
        {nav.view === "category" && area && category && (
          <CategoryView
            area={area}
            category={category}
            onBack={() => setNav({ view: "area", areaId: area.id })}
            onOpenBrand={(brandId) =>
              setNav({
                view: "brand",
                areaId: area.id,
                categoryId: category.id,
                brandId,
              })
            }
          />
        )}
        {nav.view === "brand" && area && category && brand && (
          <BrandDetailView
            area={area}
            category={category}
            brand={brand}
            onBack={() =>
              setNav({
                view: "category",
                areaId: area.id,
                categoryId: category.id,
              })
            }
          />
        )}
      </div>
    </div>
  );
}
