/**
 * Append-only three-way merge classification.
 *
 * Session logs are append-only: a device that keeps writing only ever *extends*
 * the file. That makes a byte-level three-way compare meaningful, and it lets
 * the plugin keep both lineages instead of making the user choose:
 *
 * | verdict       | condition                          | outcome                        |
 * |---------------|------------------------------------|--------------------------------|
 * | `identical`   | ours == theirs                     | keep ours                      |
 * | `ours-only`   | theirs == base                     | keep ours                      |
 * | `theirs-only` | ours == base                       | adopt theirs (no local loss)   |
 * | `append-both` | base is a prefix of both           | keep ours + fork theirs        |
 * | `diverged`    | anything else                      | keep ours + fork theirs        |
 *
 * A fork file is never deleted and never overwritten, so a remote lineage that
 * lost the decision is still recoverable by hand. Nothing is ever discarded.
 *
 * Comparison is on raw bytes: a zstd frame and a UTF-8 text file follow the same
 * rules, and no encoding assumption is made about a session log.
 * @module merge
 */

/** The verdicts this module can return. */
export const MERGE_KINDS = {
    IDENTICAL: 'identical',
    OURS_ONLY: 'ours-only',
    THEIRS_ONLY: 'theirs-only',
    APPEND_BOTH: 'append-both',
    DIVERGED: 'diverged',
};

/** Coerce any content shape into a Buffer (or undefined when absent). */
function asBuffer(value) {
    if (value === undefined || value === null)
        return undefined;
    if (Buffer.isBuffer(value))
        return value;
    return Buffer.from(String(value));
}

/** Whether `prefix` is a byte prefix of `whole` (equal lengths count). */
function isPrefix(prefix, whole) {
    return prefix !== undefined && whole !== undefined &&
        prefix.length <= whole.length &&
        whole.subarray(0, prefix.length).equals(prefix);
}

/** Both sides missing, or byte-identical. */
function equalsOrBothMissing(left, right) {
    if (left === undefined && right === undefined)
        return true;
    if (left === undefined || right === undefined)
        return false;
    return left.equals(right);
}

/**
 * Classify one path.
 *
 * @param {Buffer|string|undefined} base    the last content both sides agreed on
 * @param {Buffer|string|undefined} ours    the local content
 * @param {Buffer|string|undefined} theirs  the remote content
 * @returns {{kind: string, keepOurs: boolean, forkTheirs: boolean}}
 */
export function classifyPath(base, ours, theirs) {
    const b = asBuffer(base);
    const o = asBuffer(ours);
    const t = asBuffer(theirs);

    if (o !== undefined && t !== undefined && o.equals(t))
        return { kind: MERGE_KINDS.IDENTICAL, keepOurs: true, forkTheirs: false };
    if (o === undefined && t === undefined)
        return { kind: MERGE_KINDS.IDENTICAL, keepOurs: true, forkTheirs: false };

    // Only the local side moved: the remote still holds the agreed content.
    if (equalsOrBothMissing(t, b))
        return { kind: MERGE_KINDS.OURS_ONLY, keepOurs: true, forkTheirs: false };

    // Only the remote side moved: the local copy holds no extra bytes, so
    // adopting the remote is an update rather than an overwrite.
    if (equalsOrBothMissing(o, b))
        return { kind: MERGE_KINDS.THEIRS_ONLY, keepOurs: false, forkTheirs: false };

    // Both sides appended to the same base: keep ours in place and preserve
    // theirs beside it, so neither lineage is lost.
    if (isPrefix(b, o) && isPrefix(b, t))
        return { kind: MERGE_KINDS.APPEND_BOTH, keepOurs: true, forkTheirs: true };

    // A real divergence (rewrite, recompression, one-sided delete). Reported
    // loudly; the user decides, and both files survive.
    return { kind: MERGE_KINDS.DIVERGED, keepOurs: true, forkTheirs: true };
}

/**
 * Build the merge plan for a batch of conflicting paths.
 *
 * @param {Array<{path: string, base?: Buffer|string, ours?: Buffer|string, theirs?: Buffer|string}>} conflicts
 * @returns {{resolutions: Array<{path: string, kind: string, adoptTheirs: boolean, forkTheirs: boolean}>,
 *            summary: {kept: number, adopted: number, appended: number, diverged: number, forkPaths: string[]}}}
 */
export function planMerge(conflicts) {
    const resolutions = [];
    const summary = { kept: 0, adopted: 0, appended: 0, diverged: 0, forkPaths: [] };
    for (const entry of conflicts) {
        const verdict = classifyPath(entry.base, entry.ours, entry.theirs);
        resolutions.push({
            path: entry.path,
            kind: verdict.kind,
            adoptTheirs: !verdict.keepOurs,
            forkTheirs: verdict.forkTheirs,
        });
        if (verdict.kind === MERGE_KINDS.THEIRS_ONLY)
            summary.adopted += 1;
        else
            summary.kept += 1;
        if (verdict.kind === MERGE_KINDS.APPEND_BOTH)
            summary.appended += 1;
        if (verdict.kind === MERGE_KINDS.DIVERGED)
            summary.diverged += 1;
        if (verdict.forkTheirs)
            summary.forkPaths.push(entry.path);
    }
    return { resolutions, summary };
}

/**
 * Name a fork file: `<base>.remote-fork-<UTC 14-digit>-<device8>`.
 *
 * The 14-digit stamp is fixed-width and separator-free so the name sorts
 * chronologically and cannot be confused with a session file name.
 *
 * @param {string} fileName  the original session file name
 * @param {string} deviceId  the writing device id
 * @param {Date} [now]       injection point for tests
 */
export function forkFileName(fileName, deviceId, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '').slice(0, 14);
    const device = String(deviceId ?? '').replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8).toLowerCase() || 'unknown';
    return `${fileName}.remote-fork-${stamp}-${device}`;
}

/** Whether a file name is a fork file (never deleted, never overwritten). */
export function isForkFile(fileName) {
    return /\.remote-fork-\d{14}-[a-z0-9]{1,8}$/u.test(String(fileName));
}
