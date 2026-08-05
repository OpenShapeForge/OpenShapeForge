// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@openshapeforge/ui";

type UploadResponse = {
  storageLocation: string;
  fileName: string;
  mimeType: string;
  checksum: string;
  sizeBytes: number;
};

type FileUploadProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  value: string;
  disabled?: boolean;
  lang?: "nl" | "en";
  fileNameField?: string;
  mimeTypeField?: string;
  checksumField?: string;
  onValueChange: (storageLocation: string) => void;
  onSiblingChange: (key: string, value: string) => void;
};

function FileUpload({
  id,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
  value,
  disabled = false,
  lang = "nl",
  fileNameField,
  mimeTypeField,
  checksumField,
  onValueChange,
  onSiblingChange,
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      setError(undefined);
      setUploading(true);

      const failureMessage = lang === "nl" ? "Upload mislukt." : "Upload failed.";

      try {
        const response = await fetch("/api/documents/upload", {
          method: "POST",
          headers: { "X-Filename": file.name },
          body: file,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          const message =
            body?.error?.message ??
            (lang === "nl"
              ? `Upload mislukt (${response.status}).`
              : `Upload failed (${response.status}).`);
          setError(typeof message === "string" ? message : failureMessage);
          return;
        }

        const data = (await response.json()) as UploadResponse;
        onValueChange(data.storageLocation);
        setUploadedFileName(data.fileName);

        if (fileNameField) {
          onSiblingChange(fileNameField, data.fileName);
        }
        if (mimeTypeField) {
          onSiblingChange(mimeTypeField, data.mimeType);
        }
        if (checksumField) {
          onSiblingChange(checksumField, data.checksum);
        }
      } catch {
        setError(failureMessage);
      } finally {
        setUploading(false);
      }
    },
    [
      onValueChange,
      onSiblingChange,
      lang,
      fileNameField,
      mimeTypeField,
      checksumField,
    ],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        upload(file);
      }

      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [upload],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);

      if (disabled || uploading) {
        return;
      }

      const file = event.dataTransfer.files[0];
      if (file) {
        upload(file);
      }
    },
    [disabled, uploading, upload],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleRemove = useCallback(() => {
    onValueChange("");
    setUploadedFileName(undefined);
    setError(undefined);

    if (fileNameField) {
      onSiblingChange(fileNameField, "");
    }
    if (mimeTypeField) {
      onSiblingChange(mimeTypeField, "");
    }
    if (checksumField) {
      onSiblingChange(checksumField, "");
    }
  }, [
    onValueChange,
    onSiblingChange,
    fileNameField,
    mimeTypeField,
    checksumField,
  ]);

  const displayName =
    uploadedFileName ??
    (value
      ? value.split("/").pop() ?? (lang === "nl" ? "bestand" : "file")
      : undefined);
  const hasFile = value.length > 0;
  const uploadingLabel = lang === "nl" ? "Uploaden..." : "Uploading...";

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        className="sr-only"
        aria-describedby={ariaDescribedby}
        aria-invalid={ariaInvalid || undefined}
        disabled={disabled || uploading}
        onChange={handleFileChange}
        tabIndex={-1}
      />

      {hasFile ? (
        <div className="flex items-center gap-3 rounded-[var(--radius-field)] border border-input bg-card px-2 py-[6px]">
          <a
            href={`/api/documents/download/${value}`}
            className="min-w-0 flex-1 truncate text-sm text-primary underline hover:text-primary/80"
            target="_blank"
            rel="noopener noreferrer"
          >
            {displayName}
          </a>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading
                ? uploadingLabel
                : lang === "nl"
                  ? "Vervangen"
                  : "Replace"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || uploading}
              onClick={handleRemove}
            >
              {lang === "nl" ? "Verwijderen" : "Remove"}
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={disabled || uploading ? -1 : 0}
          className={[
            "flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-6 text-sm transition-colors",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50",
            disabled || uploading ? "pointer-events-none opacity-50" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            if (!disabled && !uploading) {
              inputRef.current?.click();
            }
          }}
          onKeyDown={(event) => {
            if (
              !disabled &&
              !uploading &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {uploading ? (
            <span className="text-muted-foreground">{uploadingLabel}</span>
          ) : (
            <span className="text-muted-foreground">
              {lang === "nl"
                ? "Sleep een bestand hierheen of klik om te selecteren"
                : "Drag a file here or click to select"}
            </span>
          )}
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export { FileUpload };
export type { FileUploadProps };
