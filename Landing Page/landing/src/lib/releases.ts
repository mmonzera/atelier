import fallback from "../content/release.fallback.json";

export interface ReleaseAsset { name: string; size: number; url: string; }
export interface ReleaseInfo { version: string | null; publishedAt: string | null; assets: ReleaseAsset[]; source: "github" | "fallback"; }

export const RELEASE_REPO = import.meta.env.ATELIER_RELEASE_REPO ?? "mmonzera/atelier";
const REPO = RELEASE_REPO;

/** Dipanggil saat build. Gagal apa pun -> fallback, build tidak boleh putus. */
export async function getRelease(): Promise<ReleaseInfo> {
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = import.meta.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const j = await res.json();
    return {
      version: j.tag_name ?? null,
      publishedAt: j.published_at ?? null,
      assets: (j.assets ?? []).map((a: any) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      source: "github",
    };
  } catch (err) {
    console.warn("[releases] pakai fallback:", (err as Error).message);
    return { ...(fallback as Omit<ReleaseInfo, "source">), source: "fallback" };
  }
}
