import { forwardRef, useImperativeHandle, useRef, useState, type DragEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, ArrowLeft, ArrowRight, Film, ImagePlus, Play, RotateCw, UploadCloud, X } from 'lucide-react';
import {
  ACCEPT_ATTRIBUTE,
  SUPPORTED_LABEL,
  formatBytes,
  formatDuration,
  type MediaConfig,
  type MediaController,
  type MediaItem,
} from './media-upload';

export type MediaUploaderHandle = { openPicker: () => void };

/** Only real file drags count; dragging one of our own tiles around must not light up the drop zone. */
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
const REORDER_TYPE = 'application/x-socialflow-media';

function Thumb({ item }: { item: MediaItem }) {
  if (item.kind === 'image') return item.src ? <img src={item.src} alt="" draggable={false} loading="lazy" /> : <Film size={22} aria-hidden />;
  if (item.poster) return <img src={item.poster} alt="" draggable={false} />;
  if (item.src && item.previewable) return <video src={`${item.src}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />;
  return <span className="sfa-mtile__fallback"><Film size={22} aria-hidden /><small>No preview</small></span>;
}

function Tile({ item, index, total, disabled, onOpen, controller, dragging, setDragging }: {
  item: MediaItem; index: number; total: number; disabled: boolean; onOpen: () => void; controller: MediaController;
  dragging: string | null; setDragging: (key: string | null) => void;
}) {
  const [over, setOver] = useState(false);
  const duration = item.kind === 'video' ? formatDuration(item.durationMs) : '';
  const reorderable = !disabled && item.status === 'done';
  const meta = [item.width && item.height ? `${item.width}×${item.height}` : null, formatBytes(item.size)].filter(Boolean).join(' · ');
  return <li className={`sfa-mtile is-${item.status} ${dragging === item.key ? 'is-dragging' : ''} ${over ? 'is-over' : ''}`} data-testid={`media-tile-${index}`} data-status={item.status}
    draggable={reorderable}
    onDragStart={(event) => { if (!reorderable) return; event.dataTransfer.setData(REORDER_TYPE, item.key); event.dataTransfer.effectAllowed = 'move'; setDragging(item.key); }}
    onDragEnd={() => { setDragging(null); setOver(false); }}
    onDragOver={(event) => { if (dragging && dragging !== item.key && event.dataTransfer.types.includes(REORDER_TYPE)) { event.preventDefault(); event.stopPropagation(); setOver(true); } }}
    onDragLeave={() => setOver(false)}
    onDrop={(event) => {
      const from = controller.items.findIndex((candidate) => candidate.key === event.dataTransfer.getData(REORDER_TYPE));
      setOver(false);
      if (from < 0) return;
      event.preventDefault(); event.stopPropagation();
      controller.move(from, index);
      setDragging(null);
    }}>
    <button type="button" className="sfa-mtile__thumb" onClick={onOpen} disabled={item.status !== 'done' && !item.src} aria-label={`Preview ${item.name}`} data-testid={`media-preview-${index}`}>
      <Thumb item={item} />
      {item.kind === 'video' && item.status !== 'error' && <span className="sfa-mtile__play" aria-hidden><Play size={16} /></span>}
    </button>
    <span className="sfa-mtile__pos sfa-num" title={`Position ${index + 1}${index === 0 ? ' (first in the post)' : ''}`}>{index + 1}</span>
    {duration && <span className="sfa-mtile__duration sfa-num" data-testid={`media-duration-${index}`}>{duration}</span>}
    {!disabled && <button type="button" className="sfa-mtile__remove" onClick={() => controller.remove(item.key)} aria-label={`Remove ${item.name}`} data-testid={`media-remove-${index}`}><X size={14} /></button>}

    {item.status === 'uploading' && <div className="sfa-mtile__progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)} data-testid={`media-progress-${index}`}>
      <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
      <small className="sfa-num">{Math.round(item.progress * 100)}%</small>
    </div>}
    {item.status === 'error' && <div className="sfa-mtile__error" role="alert" data-testid={`media-error-${index}`}>
      <AlertTriangle size={14} aria-hidden /><span>{item.error}</span>
      {item.file && <button type="button" className="sfa-linkbtn" onClick={() => controller.retry(item.key)}><RotateCw size={12} aria-hidden /> Retry</button>}
    </div>}

    <div className="sfa-mtile__foot">
      <span className="sfa-mtile__name" title={item.name}>{item.name}</span>
      <span className="sfa-mtile__meta sfa-num">{meta}</span>
      {reorderable && total > 1 && <span className="sfa-mtile__move">
        <button type="button" onClick={() => controller.move(index, index - 1)} disabled={index === 0} aria-label={`Move ${item.name} earlier`} data-testid={`media-left-${index}`}><ArrowLeft size={13} /></button>
        <button type="button" onClick={() => controller.move(index, index + 1)} disabled={index === total - 1} aria-label={`Move ${item.name} later`} data-testid={`media-right-${index}`}><ArrowRight size={13} /></button>
      </span>}
    </div>
  </li>;
}

function Lightbox({ item, onClose }: { item: MediaItem | null; onClose: () => void }) {
  return <DialogPrimitive.Root open={item !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay sfa-lightbox__overlay" />
      <DialogPrimitive.Content className="sfa-lightbox" aria-describedby={undefined} data-testid="media-lightbox">
        <DialogPrimitive.Title className="sfa-lightbox__title">{item?.name}</DialogPrimitive.Title>
        {item && (item.kind === 'image'
          ? <img src={item.src} alt={item.name} />
          : item.previewable
            ? <video src={item.src} controls autoPlay playsInline data-testid="media-lightbox-video" />
            : <p className="sfa-lightbox__note"><Film size={28} aria-hidden />This browser can’t play this video, but it will upload as-is.</p>)}
        {item && <p className="sfa-lightbox__meta sfa-num">{[item.width && item.height ? `${item.width}×${item.height}` : null, item.kind === 'video' ? formatDuration(item.durationMs) : null, formatBytes(item.size)].filter(Boolean).join(' · ')}</p>}
        <DialogPrimitive.Close className="sfa-iconbtn sfa-lightbox__close" aria-label="Close preview"><X size={18} /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export const MediaUploader = forwardRef<MediaUploaderHandle, { controller: MediaController; config: MediaConfig; disabled?: boolean }>(function MediaUploader({ controller, config, disabled = false }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const { items } = controller;
  const full = items.filter((item) => item.status !== 'error').length >= config.maxFilesPerPost;
  const previewItem = items.find((item) => item.key === previewKey) ?? null;
  useImperativeHandle(ref, () => ({ openPicker: () => inputRef.current?.click() }), []);

  const take = (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length > 0) void controller.addFiles(list);
  };

  const onDragEnter = (event: DragEvent) => { if (disabled || !hasFiles(event)) return; event.preventDefault(); depth.current += 1; setDragOver(true); };
  const onDragOver = (event: DragEvent) => { if (disabled || !hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = (event: DragEvent) => { if (!hasFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragOver(false); };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragOver(false);
    if (!disabled) take(event.dataTransfer.files);
  };

  const uploading = items.filter((item) => item.status === 'uploading').length;
  const limitText = `Images up to ${formatBytes(config.maxImageBytes)}, videos up to ${formatBytes(config.maxVideoBytes)}. Up to ${config.maxFilesPerPost} files.`;

  return <section className="sfa-uploader" aria-labelledby="composer-media" data-testid="media-uploader">
    <div className="sfa-labelrow">
      <h3 className="sfa-label" id="composer-media">Media {items.length > 0 && <span className="sfa-count sfa-num">{items.length}</span>}</h3>
      {uploading > 0 && <span className="sfa-muted" data-testid="media-uploading-count">Uploading {uploading} {uploading === 1 ? 'file' : 'files'}…</span>}
    </div>

    <div className={`sfa-dropzone ${dragOver ? 'is-over' : ''} ${disabled ? 'is-disabled' : ''} ${items.length > 0 ? 'is-compact' : ''}`} data-testid="media-dropzone"
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <span className="sfa-dropzone__icon" aria-hidden>{dragOver ? <UploadCloud size={22} /> : <ImagePlus size={22} />}</span>
      <div className="sfa-dropzone__text">
        <strong>{dragOver ? 'Drop to upload' : disabled ? 'Media can’t be changed on this post' : full ? 'This post has the most files it can hold' : 'Drag and drop images or video here'}</strong>
        <span>{SUPPORTED_LABEL}. {limitText}</span>
      </div>
      {!disabled && <button type="button" className="sfa-btn sfa-btn--secondary sfa-btn--sm" onClick={() => inputRef.current?.click()} disabled={full} data-testid="button-browse-media">Browse files</button>}
      <input ref={inputRef} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden disabled={disabled} data-testid="input-media-files" aria-label="Choose images or video"
        onChange={(event) => { take(event.target.files); event.target.value = ''; }} />
    </div>

    {controller.notice && <p className="sfa-media__notice" role="status" data-testid="media-notice"><AlertTriangle size={13} aria-hidden /> {controller.notice}</p>}

    {items.length > 0 && <>
      <ul className="sfa-mgrid" data-testid="media-grid" aria-label="Attached media, in posting order">
        {items.map((item, index) => <Tile key={item.key} item={item} index={index} total={items.length} disabled={disabled} controller={controller}
          onOpen={() => setPreviewKey(item.key)} dragging={dragging} setDragging={setDragging} />)}
      </ul>
      {items.length > 1 && !disabled && <p className="sfa-muted sfa-media__hint">Drag to reorder, or use the arrows. The first file leads the post.</p>}
    </>}
    <p className="sr-only" role="status" aria-live="polite">{controller.announcement}</p>
    <Lightbox item={previewItem} onClose={() => setPreviewKey(null)} />
  </section>;
});
