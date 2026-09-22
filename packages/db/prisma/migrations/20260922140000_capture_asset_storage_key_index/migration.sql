-- #141: the orphan sweep asks, for every object in the bucket, whether any row names
-- its key. Without this each question is a scan of every capture asset.

CREATE INDEX "CaptureAsset_storageKey_idx" ON "CaptureAsset"("storageKey");
