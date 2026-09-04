import { gzipSync } from 'node:zlib';
import { parseCloudFrontLog, cruxIdFromPublishHost } from './cloudfront-logs';

const CRUX = '550e8400-e29b-41d4-a716-446655440000';
const LOG = [
  '#Version: 1.0',
  '#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status cs(Referer) cs(User-Agent) cs-uri-query cs(Cookie) x-edge-result-type x-edge-request-id x-host-header',
  `2026-09-03\t10:00:00\tIAD1\t1200\t1.1.1.1\tGET\td111.cloudfront.net\t/\t200\t-\tUA\t-\t-\tHit\treq1\t${CRUX}.publish.crux.garden`,
  `2026-09-03\t10:00:01\tIAD1\t800\t1.1.1.1\tGET\td111.cloudfront.net\t/a.css\t200\t-\tUA\t-\t-\tHit\treq2\t${CRUX}.publish.crux.garden`,
  `2026-09-04\t00:00:01\tIAD1\t500\t1.1.1.1\tGET\td111.cloudfront.net\t/\t200\t-\tUA\t-\t-\tMiss\treq3\tblog.someone.com`,
  '',
].join('\n');

describe('CloudFront standard logs', () => {
  it('sums bytes and requests per viewer host per day, plain or gzipped', () => {
    const plain = parseCloudFrontLog(Buffer.from(LOG));
    const zipped = parseCloudFrontLog(gzipSync(Buffer.from(LOG)));
    for (const totals of [plain, zipped]) {
      expect(totals).toHaveLength(2);
      const crux = totals.find((t) => t.host.startsWith(CRUX))!;
      expect(crux).toMatchObject({
        day: '2026-09-03',
        bytes: 2000,
        requests: 2,
      });
      const custom = totals.find((t) => t.host === 'blog.someone.com')!;
      expect(custom).toMatchObject({
        day: '2026-09-04',
        bytes: 500,
        requests: 1,
      });
    }
  });

  it('ignores files without a Fields header and blank hosts', () => {
    expect(parseCloudFrontLog(Buffer.from('2026-09-03\t10:00:00\n'))).toEqual(
      [],
    );
    expect(
      parseCloudFrontLog(
        Buffer.from('#Fields: date sc-bytes x-host-header\n2026-09-03\t5\t-\n'),
      ),
    ).toEqual([]);
  });

  it('reads standard logging v2 JSON lines, with date or epoch timestamp', () => {
    const json = [
      JSON.stringify({
        date: '2026-09-03',
        time: '10:00:00',
        'sc-bytes': 700,
        'x-host-header': `${CRUX}.publish.crux.garden`,
      }),
      JSON.stringify({
        timestamp: Date.UTC(2026, 8, 3, 8) / 1000, // 2026-09-03T08:00:00Z, seconds
        'sc-bytes': '300',
        'x-host-header': `${CRUX}.Publish.crux.garden`,
      }),
      JSON.stringify({
        'timestamp(ms)': Date.UTC(2026, 8, 3, 9),
        'sc-bytes': 50,
        'x-host-header': 'blog.someone.com',
      }),
      '{not json',
      '',
    ].join('\n');
    const totals = parseCloudFrontLog(gzipSync(Buffer.from(json)));
    expect(totals).toHaveLength(2);
    expect(totals.find((t) => t.host.startsWith(CRUX))).toMatchObject({
      day: '2026-09-03',
      bytes: 1000,
      requests: 2,
    });
    expect(totals.find((t) => t.host === 'blog.someone.com')).toMatchObject({
      day: '2026-09-03',
      bytes: 50,
      requests: 1,
    });
  });

  it('recognises crux subdomains and leaves custom domains to lookup', () => {
    expect(cruxIdFromPublishHost(`${CRUX}.publish.crux.garden`)).toBe(CRUX);
    expect(cruxIdFromPublishHost('blog.someone.com')).toBeNull();
  });
});
