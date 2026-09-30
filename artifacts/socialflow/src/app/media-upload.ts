import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Media } from '@workspace/api-client-react';

/* Upload logic for the composer's media uploader: validation, metadata, real XHR uploads with progress. */

export type MediaConfig = {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxFilesPerPost: number;
  allowedTypes: Array<{ kind: 'image' | 'video'; mime: string; ext: string; label: string }>;
};

/** Used only until /api/media/config answers. The server enforces its own limits either way. */
export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  maxImageBytes: 10 * 1024 * 1024,
  maxVideoBytes: 200 * 1024 * 1024,
  maxFilesPerPost: 10,
  allowedTypes: [],
};

export type MediaItem = {
  key: string;
  /** The server's ID once uploaded (or from the start, for media already on the post). */
  id: string | null;
  kind: 'image' | 'video';
  name: string;
  size: number;
  mime: string;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  error: string | null;
  /** Object URL while uploading, then the server URL. */
  src: string;
  /** A frame captured from the video in this browser, when it could be decoded. */
  poster: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** False when this browser can't decode the file (e.g. some MOV/HEVC); it still uploads. */
  previewable: boolean;
  /** Kept so a failed upload can be retried. */
  file: File | null;
  /** True for media that was already saved on the post when the composer opened. */
  persisted: boolean;
};

const EXTENSION_KIND: Record<string, 'image' | 'video'> = { jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', mp4: 'video', mov: 'video', webm: 'video' };

export const ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.webm';
export const SUPPORTED_LABEL = 'JPG, PNG, GIF, WebP, MP4, MOV or WebM';

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function kindOf(file: File): 'image' | 'video' | null {
  if (file.type.startsWith('image/')) return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) ? 'image' : null;
  if (file.type.startsWith('video/')) return ['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) ? 'video' : null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_KIND[ext] ?? null;
}

/** Why a file can't be added, in words for the user, or null if it looks fine. The server re-checks everything. */
export function validateFile(file: File, config: MediaConfig): string | null {
  const kind = kindOf(file);
  if (!kind) return `“${file.name}” isn’t a supported file. Use ${SUPPORTED_LABEL}.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  const limit = kind === 'image' ? config.maxImageBytes : config.maxVideoBytes;
  if (file.size > limit) return `“${file.name}” is ${formatBytes(file.size)}. ${kind === 'image' ? 'Images' : 'Videos'} can be up to ${formatBytes(limit)}.`;
  return null;
}

type Measured = { width: number | null; height: number | null; durationMs: number | null; poster: string | null; previewable: boolean; unreadable: boolean };

function readImage(file: File): Promise<Measured> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight, durationMs: null, poster: null, previewable: true, unreadable: false }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: null, height: null, durationMs: null, poster: null, previewable: false, unreadable: true }); };
    img.src = url;
  });
}

/** Duration, size and a poster frame for a video. Never rejects: an undecodable video is still uploadable. */
function readVideo(file: File): Promise<Measured> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (result: Measured) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = window.setTimeout(() => finish({ width: null, height: null, durationMs: null, poster: null, previewable: false, unreadable: false }), 8000);
    const capture = () => {
      let poster: string | null = null;
      try {
        const scale = Math.min(1, 320 / Math.max(video.videoWidth, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        poster = canvas.toDataURL('image/jpeg', 0.7);
      } catch { /* a frame couldn't be drawn; the tile falls back to the video element */ }
      const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
      finish({ width: video.videoWidth || null, height: video.videoHeight || null, durationMs: duration, poster, previewable: true, unreadable: false });
    };
    video.onerror = () => finish({ width: null, height: null, durationMs: null, poster: null, previewable: false, unreadable: false });
    video.onloadedmetadata = () => {
      // Some WebM files (e.g. browser recordings) report an infinite duration until the end is seeked to.
      if (video.duration === Infinity) {
        video.onseeked = () => { video.onseeked = () => capture(); video.currentTime = 0; };
        video.currentTime = 1e101;
        return;
      }
      video.onseeked = () => capture();
      video.currentTime = Math.min(0.1, (video.duration || 0.2) / 2);
    };
    video.src = url;
  });
}

type UploadResponse = Media;

function uploadFile(file: File, measured: Measured, onProgress: (fraction: number) => void, register: (abort: () => void) => void): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    if (measured.width) xhr.setRequestHeader('X-Media-Width', String(measured.width));
    if (measured.height) xhr.setRequestHeader('X-Media-Height', String(measured.height));
    if (measured.durationMs !== null) xhr.setRequestHeader('X-Media-Duration-Ms', String(measured.durationMs));
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as UploadResponse);
      const message = (xhr.response as { message?: string } | null)?.message;
      if (xhr.status === 401) return reject(new Error('Your session expired. Sign in again to upload.'));
      if (xhr.status === 429) return reject(new Error('Too many uploads at once. Wait a moment and try again.'));
      reject(new Error(message ?? `The upload failed (error ${xhr.status}). Please try again.`));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload timed out. Please try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    register(() => xhr.abort());
    xhr.send(file);
  });
}

const CONCURRENCY = 2;
let keyCounter = 0;
const newKey = () => `m${Date.now().toString(36)}${(keyCounter++).toString(36)}`;

export function itemFromMedia(media: Media): MediaItem {
  return {
    key: media.id, id: media.id, kind: media.kind, name: media.fileName, size: media.sizeBytes, mime: media.mimeType, status: 'done', progress: 1, error: null,
    src: media.url, poster: null, width: media.width, height: media.height, durationMs: media.durationMs, previewable: true, file: null, persisted: true,
  };
}

export function useMediaConfig(): MediaConfig {
  const [config, setConfig] = useState<MediaConfig>(DEFAULT_MEDIA_CONFIG);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/media/config')
      .then((response) => (response.ok ? (response.json() as Promise<MediaConfig>) : null))
      .then((value) => { if (value && !cancelled) setConfig(value); })
      .catch(() => { /* keep the defaults; the server still enforces its limits */ });
    return () => { cancelled = true; };
  }, []);
  return config;
}

export type MediaController = ReturnType<typeof useMediaItems>;

/**
 * The composer's media list: uploads new files (two at a time), tracks progress and errors, and keeps the
 * order the user arranged. `readyIds` are the server IDs to save with the post, in display order.
 */
export function useMediaItems(initial: Media[], config: MediaConfig) {
  const [items, setItems] = useState<MediaItem[]>(() => initial.map(itemFromMedia));
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const aborts = useRef(new Map<string, () => void>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const configRef = useRef(config);
  configRef.current = config;
  const measuredRef = useRef(new Map<string, Measured>());

  const patch = useCallback((key: string, change: Partial<MediaItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY && queue.current.length > 0) {
      const key = queue.current.shift()!;
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      if (!item?.file) continue;
      active.current += 1;
      const measured = measuredRef.current.get(key) ?? { width: item.width, height: item.height, durationMs: item.durationMs, poster: item.poster, previewable: item.previewable, unreadable: false };
      uploadFile(item.file, measured, (fraction) => patch(key, { progress: fraction }), (abort) => aborts.current.set(key, abort))
        .then((media) => {
          patch(key, { id: media.id, mime: media.mimeType, kind: media.kind, status: 'done', progress: 1, error: null, width: media.width ?? measured.width, height: media.height ?? measured.height, durationMs: media.durationMs ?? measured.durationMs });
          setAnnouncement(`${item.name} uploaded.`);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          const message = error instanceof Error ? error.message : 'The upload failed.';
          patch(key, { status: 'error', error: message });
          setAnnouncement(`${item.name} failed to upload. ${message}`);
        })
        .finally(() => { aborts.current.delete(key); active.current -= 1; pump(); });
    }
  }, [patch]);

  const addFiles = useCallback(async (files: File[]) => {
    const cfg = configRef.current;
    const accepted: MediaItem[] = [];
    const rejected: MediaItem[] = [];
    let skipped = 0;
    const existing = itemsRef.current.filter((item) => item.status !== 'error').length;

    for (const file of files) {
      const problem = validateFile(file, cfg);
      const kind = kindOf(file) ?? 'image';
      const base = { key: newKey(), id: null, kind, name: file.name, size: file.size, mime: file.type, progress: 0, src: '', poster: null, width: null, height: null, durationMs: null, previewable: true, file, persisted: false } satisfies Omit<MediaItem, 'status' | 'error'>;
      if (problem) { rejected.push({ ...base, file: null, status: 'error', error: problem }); continue; }
      if (existing + accepted.length >= cfg.maxFilesPerPost) { skipped += 1; continue; }
      accepted.push({ ...base, status: 'uploading', error: null, src: URL.createObjectURL(file) });
    }
    setNotice(skipped > 0 ? `A post can have up to ${cfg.maxFilesPerPost} files, so ${skipped} ${skipped === 1 ? 'file was' : 'files were'} skipped.` : null);
    if (accepted.length === 0 && rejected.length === 0) return;
    setItems((current) => [...current, ...accepted, ...rejected]);

    // Measure in the browser (size, duration, poster frame), then start uploading. An image the browser can't
    // decode at all is rejected here, since the networks couldn't use it either.
    for (const item of accepted) {
      const measured = item.kind === 'image' ? await readImage(item.file!) : await readVideo(item.file!);
      if (measured.unreadable) {
        URL.revokeObjectURL(item.src);
        patch(item.key, { status: 'error', error: `“${item.name}” can’t be read as an image. It may be damaged.`, file: null, src: '' });
        continue;
      }
      measuredRef.current.set(item.key, measured);
      patch(item.key, { width: measured.width, height: measured.height, durationMs: measured.durationMs, poster: measured.poster, previewable: measured.previewable });
      queue.current.push(item.key);
    }
    pump();
  }, [patch, pump]);

  /**
   * Attaches media that already exists on the server (e.g. from the content library) without uploading again.
   * Marked persisted so removing it from the post or abandoning the composer never deletes the library's file.
   * Returns 'added', 'duplicate', or 'limit' (a post can't have more files than the per-post limit).
   */
  const attachExisting = useCallback((media: Media): 'added' | 'duplicate' | 'limit' => {
    const current = itemsRef.current;
    if (current.some((item) => item.id === media.id)) return 'duplicate';
    const limit = configRef.current.maxFilesPerPost;
    if (current.filter((item) => item.status !== 'error').length >= limit) {
      setNotice(`A post can have up to ${limit} files, so this one wasn’t added.`);
      return 'limit';
    }
    const item = itemFromMedia(media);
    // Update the ref right away so two quick picks can't both slip past the limit or the duplicate check.
    itemsRef.current = [...current, item];
    setItems((existing) => (existing.some((candidate) => candidate.id === media.id) ? existing : [...existing, item]));
    setNotice(null);
    setAnnouncement(`${media.fileName} added from the library.`);
    return 'added';
  }, []);

  const retry = useCallback((key: string) => {
    const item = itemsRef.current.find((candidate) => candidate.key === key);
    if (!item?.file) return;
    patch(key, { status: 'uploading', progress: 0, error: null });
    queue.current.push(key);
    pump();
  }, [patch, pump]);

  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((candidate) => candidate.key === key);
    if (!item) return;
    aborts.current.get(key)?.();
    queue.current = queue.current.filter((queued) => queued !== key);
    if (item.src.startsWith('blob:')) URL.revokeObjectURL(item.src);
    setItems((current) => current.filter((candidate) => candidate.key !== key));
    // A file uploaded in this session but not yet on a post is deleted right away. Media already on the post
    // is deleted by the server when the post is saved without it.
    if (item.id && !item.persisted) void fetch(`/api/media/${item.id}`, { method: 'DELETE' }).catch(() => {});
    setAnnouncement(`${item.name} removed.`);
  }, []);

  const move = useCallback((from: number, to: number) => {
    setItems((current) => {
      if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return current;
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }, []);

  /** Abandoning the composer: stop transfers and delete uploads that never made it onto a post. */
  const discard = useCallback(() => {
    for (const abort of aborts.current.values()) abort();
    for (const item of itemsRef.current) {
      if (item.src.startsWith('blob:')) URL.revokeObjectURL(item.src);
      if (item.id && !item.persisted) void fetch(`/api/media/${item.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
  }, []);

  useEffect(() => () => {
    for (const item of itemsRef.current) if (item.src.startsWith('blob:')) URL.revokeObjectURL(item.src);
  }, []);

  const uploading = useMemo(() => items.some((item) => item.status === 'uploading'), [items]);
  const failed = useMemo(() => items.filter((item) => item.status === 'error').length, [items]);
  const readyIds = useMemo(() => items.filter((item) => item.status === 'done' && item.id).map((item) => item.id!), [items]);

  return { items, notice, setNotice, announcement, addFiles, attachExisting, retry, remove, move, discard, uploading, failed, readyIds };
}
