/**
 * JSX visuals for `EntityPill`: file extension → icon mapping, plus
 * the leading-icon component dispatched off `EntityPillKind`.
 *
 * Pure data helpers (kind union, label, entity → kind mapping) live in
 * `entity-pill-kind.ts` so this module exports only components and stays
 * compatible with the React fast-refresh lint rule.
 */

import type { ComponentType } from "react";

import {
  AddressBook,
  CalendarClock,
  Database,
  File,
  FileAudio,
  FileCloud,
  FileCode,
  FileCsv,
  FileDoc,
  FileHtml,
  FileJpg,
  FilePdf,
  FilePpt,
  FileText,
  FileVideo,
  FileXls,
  FileXml,
  Mail,
  PenNib,
  User,
} from "@/components/icons";
import { cn } from "@/lib/marshal-class-names";

import type { EntityPillKind } from "./entity-pill-kind";

type FileGlyph = ComponentType<{ className?: string }>;

const FILE_EXT_ICONS: Record<string, FileGlyph> = {
  doc: FileDoc,
  docx: FileDoc,
  xls: FileXls,
  xlsx: FileXls,
  xlsm: FileXls,
  xlsb: FileXls,
  csv: FileCsv,
  ppt: FilePpt,
  pptx: FilePpt,
  ppsx: FilePpt,
  pdf: FilePdf,
  txt: FileText,
  md: FileText,
  log: FileText,
  rtf: FileText,
  png: FileJpg,
  jpg: FileJpg,
  jpeg: FileJpg,
  gif: FileJpg,
  webp: FileJpg,
  svg: FileJpg,
  bmp: FileJpg,
  ico: FileJpg,
  tif: FileJpg,
  tiff: FileJpg,
  heic: FileJpg,
  heif: FileJpg,
  avif: FileJpg,
  ai: PenNib,
  eps: PenNib,
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  m4a: FileAudio,
  aac: FileAudio,
  ogg: FileAudio,
  oga: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  mkv: FileVideo,
  avi: FileVideo,
  webm: FileVideo,
  m4v: FileVideo,
  wmv: FileVideo,
  eml: Mail,
  msg: Mail,
  ics: CalendarClock,
  vcf: AddressBook,
  html: FileHtml,
  htm: FileHtml,
  json: FileCode,
  yml: FileCode,
  yaml: FileCode,
  xml: FileXml,
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cc: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  php: FileCode,
  sh: FileCode,
  ps1: FileCode,
  css: FileCode,
  scss: FileCode,
  sass: FileCode,
  less: FileCode,
  loop: FileCloud,
  fluid: FileCloud,
  vsd: File,
  vsdx: File,
  vssx: File,
  vstx: File,
  mpp: File,
  pub: FileText,
  accdb: Database,
  mdb: Database,
};

interface FileExtensionIconProps {
  extension?: string;
  className?: string;
}

/** Stand-alone file icon used in picker result rows that don't render a pill. */
export function FileExtensionIcon({
  extension,
  className = "size-5 shrink-0",
}: FileExtensionIconProps) {
  const ext = extension?.toLowerCase().replace(/^\./, "") ?? "";
  const Icon = FILE_EXT_ICONS[ext] ?? File;
  return <Icon className={className} />;
}

interface EntityPillIconProps {
  kind: EntityPillKind;
  size: "sm" | "md";
}

/**
 * Renders the leading visual for a pill. Image kind is handled separately by
 * `EntityPill` (renders a square thumbnail instead of an icon), so this
 * component returns null in that case.
 */
export function EntityPillIcon({ kind, size }: EntityPillIconProps) {
  switch (kind.type) {
    case "person":
      return (
        <User
          className={cn("shrink-0 text-muted-foreground", size === "md" ? "size-5" : "size-3.5")}
        />
      );
    case "file":
      return (
        <FileExtensionIcon
          extension={kind.extension}
          className={cn("shrink-0", size === "md" ? "size-5" : "size-3.5")}
        />
      );
    case "image":
      return null;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
