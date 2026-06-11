"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar as CalendarIcon, Clock, ChevronLeft, ChevronRight } from "lucide-react";

interface DateTimePickerProps {
  value: string | null;
  onChange: (iso: string | null) => void;
  placeholder?: string;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export function DateTimePicker({ value, onChange, placeholder = "Select expiry…" }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const initial = value ? new Date(value) : null;
  const [year, setYear] = useState(initial?.getFullYear() ?? new Date().getFullYear());
  const [month, setMonth] = useState(initial?.getMonth() ?? new Date().getMonth());
  const [time, setTime] = useState(() => {
    if (initial) {
      return `${String(initial.getHours()).padStart(2, "0")}:${String(initial.getMinutes()).padStart(2, "0")}`;
    }
    return "00:00";
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(initial?.getDate() ?? null);

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const handleDayClick = (day: number) => {
    setSelectedDay(day);
  };

  const handleApply = () => {
    if (!selectedDay) {
      onChange(null);
      setOpen(false);
      return;
    }
    const [h, m] = time.split(":").map(Number);
    const dt = new Date(year, month, selectedDay, h, m, 0, 0);
    onChange(dt.toISOString());
    setOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setSelectedDay(null);
    setOpen(false);
  };

  const displayValue = (() => {
    if (!value) return placeholder;
    const d = new Date(value);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  })();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[#182533] border text-sm transition-all ${
          open || value ? "border-[#5DBE81] ring-1 ring-[#5DBE81]/30" : "border-[#232E3C]"
        } text-[#FFFFFF] hover:border-[#5DBE81]/50`}
      >
        <CalendarIcon className="w-4 h-4 text-[#5E6875]" />
        <span className={value ? "text-[#FFFFFF]" : "text-[#232E3C]"}>{displayValue}</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-80 rounded-xl border border-[#232E3C] bg-[#17212B] shadow-xl shadow-black/60 p-4 space-y-4">
          {/* Month / Year nav */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (month === 0) { setMonth(11); setYear(y => y - 1); }
                else setMonth(m => m - 1);
              }}
              className="p-1 rounded hover:bg-[#182533] text-[#8A9BA8]"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-[#FFFFFF]">
              {monthNames[month]} {year}
            </span>
            <button
              type="button"
              onClick={() => {
                if (month === 11) { setMonth(0); setYear(y => y + 1); }
                else setMonth(m => m + 1);
              }}
              className="p-1 rounded hover:bg-[#182533] text-[#8A9BA8]"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
              <div key={d} className="text-[#232E3C] py-1">{d}</div>
            ))}
            {Array.from({ length: firstDay }, (_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const isSelected = selectedDay === day;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => handleDayClick(day)}
                  className={`py-1.5 rounded-md text-sm transition-colors ${
                    isSelected
                      ? "bg-[#5DBE81] text-black font-semibold"
                      : "text-[#8A9BA8] hover:bg-[#182533] hover:text-[#FFFFFF]"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Time picker */}
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#5E6875]" />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="flex-1 px-2 py-1.5 rounded-md bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleClear}
              className="flex-1 px-3 py-2 rounded-lg text-xs font-medium text-[#5E6875] hover:text-[#FFFFFF] hover:bg-[#182533] transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="flex-1 px-3 py-2 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
