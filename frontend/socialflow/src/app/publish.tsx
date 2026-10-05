import { useQueryClient } from '@tanstack/react-query';
import { getListPostsQueryKey, usePublishPostNow, type Post } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';

/** A one-line result for a finished publish attempt, from the per-account outcomes. */
export function summarizePublish(post: Post): { ok: boolean; title: string; description?: string } {
  const published = post.targets.filter((target) => target.status === 'published');
  const failed = post.targets.filter((target) => target.status === 'failed');
  if (failed.length === 0 && published.length > 0) {
    return { ok: true, title: published.length === 1 ? `Published to ${published[0]!.accountName}` : `Published to ${published.length} accounts` };
  }
  const reason = failed.find((target) => target.errorMessage);
  const where = failed.length === 1 ? failed[0]!.accountName : `${failed.length} accounts`;
  return {
    ok: false,
    title: published.length > 0 ? `Published to ${published.length}, but not to ${where}` : `Couldn't publish to ${where}`,
    description: reason?.errorMessage ?? undefined,
  };
}

/** Asks the user to confirm publishing to real accounts. */
export function confirmPublish(confirm: ReturnType<typeof useConfirm>, accountNames: string[], retry: boolean): Promise<boolean> {
  return confirm({
    title: retry ? 'Retry publishing this post?' : 'Publish this post now?',
    description: `It will be posted immediately to ${accountNames.join(', ') || 'the selected accounts'}. This can’t be undone from Socialflow.`,
    confirmLabel: retry ? 'Retry now' : 'Publish now',
  });
}

/**
 * Publishes a post right now, after an explicit confirmation (it posts to real
 * accounts and can't be undone from here). Resolves to the updated post, or
 * null if the user cancelled or the request itself failed.
 */
export function usePublishNow() {
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = usePublishPostNow();

  /** `confirmed` is for callers that already asked (the composer confirms before it saves anything). */
  const publishNow = async (post: Post, options: { confirmed?: boolean } = {}): Promise<Post | null> => {
    const names = post.targets.filter((target) => target.status !== 'published').map((target) => target.accountName);
    if (!options.confirmed && !(await confirmPublish(confirm, names, post.status === 'failed'))) return null;
    try {
      const updated = await mutation.mutateAsync({ postId: post.id });
      queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
      const summary = summarizePublish(updated);
      toast({ title: summary.title, description: summary.description, variant: summary.ok ? 'default' : 'destructive' });
      return updated;
    } catch (error) {
      const message = (error as { data?: { message?: string } | null }).data?.message ?? 'Something went wrong. Please try again.';
      toast({ title: "Couldn't publish", description: message, variant: 'destructive' });
      return null;
    }
  };

  return { publishNow, publishing: mutation.isPending };
}
