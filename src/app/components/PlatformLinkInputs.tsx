"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PlatformIcon } from "@/lib/platforms/PlatformIcon";
import { detectPlatformFromUrl, getPlatformName } from "@/lib/platforms/client";

export interface PlatformLinkInput { id: string; platform?: string; url: string; }

export function PlatformLinkInputs({ links, onChange }: { links: PlatformLinkInput[]; onChange: (links: PlatformLinkInput[]) => void }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const load = () => { try { setOverrides(JSON.parse(window.localStorage.getItem("h2h-platform-enabled") ?? "{}")); } catch { setOverrides({}); } };
    load();
    window.addEventListener("h2h-platforms-changed", load);
    return () => window.removeEventListener("h2h-platforms-changed", load);
  }, []);
  const selectablePlatforms = ['kalshi', 'polymarket', 'opinion', 'ibkr'].filter(id => overrides[id] !== false);
  const update = (id: string, patch: Partial<PlatformLinkInput>) => onChange(links.map(link => link.id === id ? { ...link, ...patch } : link));
  const remove = (id: string) => onChange(links.filter(link => link.id !== id));
  const add = () => onChange([...links, { id: crypto.randomUUID(), url: "" }]);

  return <div className="space-y-3">
    {links.map((link, index) => {
      const detected = detectPlatformFromUrl(link.url);
      const platform = detected ?? link.platform;
      return <div key={link.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-end">
        <label className="space-y-1.5 text-sm font-medium text-[#8A9BA8]">
          <span>Link {index + 1}</span>
          <select value={platform ?? ""} onChange={e => update(link.id, { platform: e.target.value || undefined })} className="w-full rounded-lg border border-[#232E3C] bg-[#182533] px-2.5 py-2 text-sm text-[#FFFFFF] focus:border-[#5DBE81] focus:outline-none">
            <option value="">Auto-detect</option>
            {selectablePlatforms.map(id => <option key={id} value={id}>{getPlatformName(id)}</option>)}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium text-[#8A9BA8]">
          <span className="flex items-center gap-2">{platform ? <PlatformIcon platform={platform} /> : null}{platform ? getPlatformName(platform) : "Market URL"}</span>
          <input type="url" value={link.url} onChange={e => update(link.id, { url: e.target.value })} placeholder="https://platform.example/market/..." className="w-full rounded-lg border border-[#232E3C] bg-[#182533] px-3 py-2.5 text-sm text-[#FFFFFF] placeholder-[#48555F] focus:border-[#5DBE81] focus:outline-none focus:ring-1 focus:ring-[#5DBE81]/30" />
        </label>
        <button type="button" onClick={() => remove(link.id)} disabled={links.length <= 2} title="Remove link" className="mb-0.5 rounded-lg border border-[#232E3C] p-2.5 text-[#8A9BA8] hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
      </div>;
    })}
    <button type="button" onClick={add} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5DBE81] hover:text-[#7bd49d]"><Plus className="h-3.5 w-3.5" /> Add platform link</button>
  </div>;
}
