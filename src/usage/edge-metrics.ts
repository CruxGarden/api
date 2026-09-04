import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';

/**
 * CloudFront's own count of bytes served by the publish distribution, per UTC
 * day. This is the number AWS bills us for; our log-derived total is checked
 * against it. Behind an interface so reconciliation is testable offline.
 */
export interface EdgeMetrics {
  /** Sum of BytesDownloaded for the UTC day (YYYY-MM-DD); null when unavailable. */
  bytesDownloaded(day: string): Promise<number | null>;
}

export function cloudWatchEdgeMetrics(
  cw: CloudWatchClient,
  distributionId: string,
): EdgeMetrics {
  return {
    async bytesDownloaded(day) {
      const start = new Date(`${day}T00:00:00Z`);
      const end = new Date(start.getTime() + 86_400_000);
      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/CloudFront',
          MetricName: 'BytesDownloaded',
          Dimensions: [
            { Name: 'DistributionId', Value: distributionId },
            { Name: 'Region', Value: 'Global' },
          ],
          StartTime: start,
          EndTime: end,
          Period: 86_400,
          Statistics: ['Sum'],
        }),
      );
      const points = res.Datapoints ?? [];
      if (!points.length) return null;
      return points.reduce((s, p) => s + (p.Sum ?? 0), 0);
    },
  };
}

/** From env: CloudWatch-backed metrics when the distribution is configured, else null. */
export function edgeMetricsFromEnv(): EdgeMetrics | null {
  const distributionId = process.env.PUBLISH_DISTRIBUTION_ID;
  if (
    !distributionId ||
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY
  )
    return null;
  // CloudFront metrics live in us-east-1 regardless of where anything else runs
  return cloudWatchEdgeMetrics(
    new CloudWatchClient({
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    }),
    distributionId,
  );
}
