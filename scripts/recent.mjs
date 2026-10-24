import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = path.join(ROOT, "data/stats");

const USERNAME = "Master3307";
const TIMEZONE = "Europe/Berlin";

const WEEKS = 13;
const PROJECT_DAYS = 30;
const MAX_PROJECTS = 13;

const WIDTH = 720;
const PADDING = 24;

const TEXT_COLOR = "#8e58d4";
const TITLE_COLOR = "#dc8add";

const SECTION_GAP = 28;
const MIN_REPOSITORY_WIDTH = 320;

// Animation timing, in seconds.
const CHARACTER_INTERVAL = 0.035;
const MAX_TYPING_DURATION = 1.65;
const ROW_STAGGER = 0.12;

const token = process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN is required.");
}

if (!Number.isInteger(WEEKS) || WEEKS < 1 || WEEKS > 52) {
  throw new Error("WEEKS must be an integer between 1 and 52.");
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );

const segmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

function characters(value) {
  return Array.from(segmenter.segment(String(value)), ({ segment }) => segment);
}

// Reveal each character without changing its natural position.
function typingSpans(value, start = 0.2) {
  const letters = characters(value);

  const interval = Math.min(
    CHARACTER_INTERVAL,
    MAX_TYPING_DURATION / Math.max(letters.length - 1, 1),
  );

  return letters
    .map((character, index) => {
      const revealAt = (start + index * interval).toFixed(3);

      return (
        `<tspan class="typing-character">` +
        `${escape(character)}` +
        `<set attributeName="visibility" to="hidden" ` +
        `begin="0s" dur="${revealAt}s"/>` +
        `</tspan>`
      );
    })
    .join("");
}

function textMarkup(x, y, value, attributes = "", start = 0.2) {
  return (
    `<text x="${x}" y="${y}" ${attributes} xml:space="preserve">` +
    typingSpans(value, start) +
    `</text>`
  );
}

function dateInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function shift(date, amount) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}

function weekday(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

// Conservative width estimates for the configured sans-serif font.
// A clip path also prevents names from entering the count column.
function estimatedTextWidth(value, fontSize = 14) {
  return Array.from(String(value)).reduce((width, character) => {
    if (/[ilI1.,:;!'|]/.test(character)) {
      return width + fontSize * 0.34;
    }

    if (/[MW@#%&]/.test(character)) {
      return width + fontSize * 0.95;
    }

    return width + fontSize * 0.64;
  }, 0);
}

function clipToWidth(value, maximumWidth, fontSize = 14) {
  const original = String(value);

  if (estimatedTextWidth(original, fontSize) <= maximumWidth) {
    return original;
  }

  const letters = Array.from(original);

  while (
    letters.length &&
    estimatedTextWidth(`${letters.join("")}…`, fontSize) > maximumWidth
  ) {
    letters.pop();
  }

  return `${letters.join("")}…`;
}

async function graphql(query, variables) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "MrKoby07-profile-generator",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const error = new Error(`GitHub returned HTTP ${response.status}`);

        error.retryable = response.status === 429 || response.status >= 500;

        throw error;
      }

      const result = await response.json();

      if (result.errors?.length || !result.data) {
        const error = new Error(
          "GitHub GraphQL query failed: " +
            (result.errors ?? []).map(({ message }) => message).join("; "),
        );

        error.retryable = false;
        throw error;
      }

      return result.data;
    } catch (error) {
      if (attempt === 2 || error.retryable === false) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}

const now = new Date();
const today = dateInTimezone(now);
const monday = shift(today, -weekday(today));
const calendarStart = shift(monday, -(WEEKS - 1) * 7);
const projectStart = shift(today, -(PROJECT_DAYS - 1));

const data = await graphql(
  `
    query (
      $login: String!
      $calendarFrom: DateTime!
      $projectsFrom: DateTime!
      $to: DateTime!
    ) {
      user(login: $login) {
        id

        calendar: contributionsCollection(from: $calendarFrom, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }

        recent: contributionsCollection(from: $projectsFrom, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              owner {
                login
              }
              name
              nameWithOwner
              isPrivate
              url
            }

            contributions(first: 100) {
              nodes {
                occurredAt
              }
            }
          }
        }
      }
    }
  `,
  {
    login: USERNAME,
    calendarFrom: `${calendarStart}T00:00:00Z`,
    projectsFrom: `${projectStart}T00:00:00Z`,
    to: now.toISOString(),
  },
);

if (!data.user) {
  throw new Error(`GitHub user not found: ${USERNAME}`);
}

const user = data.user;
const days = {};

for (const week of user.calendar.contributionCalendar.weeks) {
  for (const day of week.contributionDays) {
    if (day.date >= calendarStart && day.date <= today) {
      days[day.date] = day.contributionCount;
    }
  }
}

const repositories = user.recent.commitContributionsByRepository
  .filter(({ repository }) => !repository.isPrivate)
  .map(({ repository, contributions }) => ({
    ...repository,
    lastActivity:
      contributions.nodes
        .map(({ occurredAt }) => occurredAt)
        .sort()
        .at(-1) ?? "",
  }))
  .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

// Fetch exact counts instead of summing a limited page of commits.
// No commit messages, hashes, or individual commit records are requested.
const projects = [];

for (const repository of repositories) {
  if (projects.length >= MAX_PROJECTS) {
    break;
  }

  const result = await graphql(
    `
      query (
        $owner: String!
        $name: String!
        $author: ID!
        $since: GitTimestamp!
        $until: GitTimestamp!
      ) {
        repository(owner: $owner, name: $name) {
          isPrivate

          defaultBranchRef {
            target {
              ... on Commit {
                history(
                  first: 1
                  author: { id: $author }
                  since: $since
                  until: $until
                ) {
                  totalCount
                }
              }
            }
          }
        }
      }
    `,
    {
      owner: repository.owner.login,
      name: repository.name,
      author: user.id,
      since: `${projectStart}T00:00:00Z`,
      until: now.toISOString(),
    },
  );

  if (result.repository?.isPrivate !== false) {
    throw new Error(
      `Cannot safely render repository details: ${repository.nameWithOwner}`,
    );
  }

  const history = result.repository.defaultBranchRef?.target?.history;

  if (!history || history.totalCount === 0) {
    continue;
  }

  projects.push({
    ...repository,
    count: history.totalCount,
  });
}

const colors = ["#8e58d4", "#49305f", "#70429a", "#a566c0", "#dc8add"];

function level(count) {
  if (count === 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 10) return 3;
  return 4;
}

const fragments = [];
const definitions = [];

function text(x, y, value, attributes = "", start = 0.2) {
  fragments.push(textMarkup(x, y, value, attributes, start));
}

function linkedText(
  url,
  x,
  y,
  value,
  attributes = "",
  title = "",
  start = 0.2,
) {
  fragments.push(
    `<a href="${escape(url)}">` +
      (title ? `<title>${escape(title)}</title>` : "") +
      textMarkup(x, y, value, attributes, start) +
      `</a>`,
  );
}

function square(x, y, size, value, title, current = false, delay = 0.4) {
  fragments.push(
    `<g class="cell-arrive" style="--delay:${delay.toFixed(3)}s">
      <rect
        x="${x}"
        y="${y}"
        width="${size}"
        height="${size}"
        rx="${Math.min(3, size / 4)}"
        fill="${colors[level(value)]}"
        fill-opacity="${value === 0 ? ".14" : "1"}"
        stroke="${current ? TITLE_COLOR : TEXT_COLOR}"
        stroke-opacity="${current ? "1" : ".18"}"
        stroke-width="${current ? "1.4" : ".6"}">
        <title>${escape(title)}</title>
      </rect>
    </g>`,
  );
}

// Calendar layout.

const gridX = 67;
const gridY = 94;
const availableGridWidth = WIDTH - PADDING - gridX;

const pitch = Math.min(21, Math.floor(availableGridWidth / WEEKS));

const cellSize = Math.min(15, pitch - 4);
const gridWidth = (WEEKS - 1) * pitch + cellSize;
const gridRight = gridX + gridWidth;
const gridBottom = gridY + 6 * pitch + cellSize;

// Include the legend and heading when calculating section width.

const legendSize = 15;
const legendPitch = 22;
const legendWidth = 188;

const gridCenterX = gridX + gridWidth / 2;
const legendX = gridCenterX - legendWidth / 2;

const legendY = gridBottom + 13;
const legendBottom = legendY + legendSize;

const activityRight = Math.max(gridRight, legendX + legendWidth, PADDING + 200);

const sideRepositoryX = activityRight + SECTION_GAP;
const sideRepositoryWidth = WIDTH - PADDING - sideRepositoryX;

const repositoriesBeside = sideRepositoryWidth >= MIN_REPOSITORY_WIDTH;

const repositoryX = repositoriesBeside ? sideRepositoryX : PADDING;

const repositoryRight = WIDTH - PADDING;
const repositoryWidth = repositoryRight - repositoryX;

const repositoryHeadingY = repositoriesBeside ? 31 : legendBottom + 42;

// Activity header.

text(PADDING, 31, "Recent Activity", 'class="heading"', 0.2);

text(PADDING, 55, `Last ${WEEKS} weeks`, 'class="muted"', 0.48);

// Calendar cells and month labels.

let previousMonth = "";
let lastMonthLabelX = -Infinity;

for (let week = 0; week < WEEKS; week++) {
  const weekStart = shift(calendarStart, week * 7);
  const month = weekStart.slice(0, 7);
  const monthX = gridX + week * pitch;

  const weekProgress = WEEKS === 1 ? 0 : week / (WEEKS - 1);

  if (month !== previousMonth) {
    const label = new Intl.DateTimeFormat("en", {
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${weekStart}T12:00:00Z`));

    if (monthX - lastMonthLabelX >= 34) {
      text(
        monthX,
        gridY - 13,
        label,
        'class="small"',
        0.45 + weekProgress * 0.6,
      );

      lastMonthLabelX = monthX;
    }

    if (week > 0) {
      fragments.push(
        `<path
          class="month-divider"
          style="--delay:${(0.5 + weekProgress * 0.6).toFixed(3)}s"
          d="M ${monthX - 3} ${gridY - 3} V ${gridBottom + 3}"
          stroke="${TEXT_COLOR}"
          stroke-opacity=".13"
          stroke-dasharray="2 4"
          fill="none"/>`,
      );
    }

    previousMonth = month;
  }

  for (let row = 0; row < 7; row++) {
    const date = shift(weekStart, row);

    if (date > today) {
      continue;
    }

    const x = gridX + week * pitch;
    const y = gridY + row * pitch;
    const count = days[date];

    const cellDelay = 0.4 + weekProgress * 0.85 + row * 0.035;

    if (count === undefined) {
      fragments.push(
        `<g
          class="cell-arrive"
          style="--delay:${cellDelay.toFixed(3)}s">
          <rect
            x="${x}"
            y="${y}"
            width="${cellSize}"
            height="${cellSize}"
            rx="${Math.min(3, cellSize / 4)}"
            fill="none"
            stroke="${TEXT_COLOR}"
            stroke-opacity=".4"
            stroke-dasharray="2 2">
            <title>${escape(date)}: unavailable</title>
          </rect>
        </g>`,
      );

      continue;
    }

    square(
      x,
      y,
      cellSize,
      count,
      `${date}: ${count} contributions${
        date === today ? "・today, incomplete" : ""
      }`,
      date === today,
      cellDelay,
    );
  }
}

[
  ["Mon", 0],
  ["Wed", 2],
  ["Fri", 4],
  ["Sun", 6],
].forEach(([label, row], index) => {
  text(
    PADDING,
    gridY + row * pitch + cellSize - 2,
    label,
    'class="small"',
    0.4 + index * 0.1,
  );
});

// Heatmap legend, directly beneath the grid.

text(legendX, legendY + 11, "Less", 'class="small"', 1.15);

[0, 1, 3, 6, 10].forEach((value, index) => {
  const labels = {
    0: "0 contributions",
    1: "1–2 contributions",
    3: "3–5 contributions",
    6: "6–9 contributions",
    10: "10 or more contributions",
  };

  square(
    legendX + 39 + index * legendPitch,
    legendY,
    legendSize,
    value,
    labels[value],
    false,
    1.15 + index * 0.065,
  );
});

text(legendX + 158, legendY + 11, "More", 'class="small"', 1.48);

// Recent repositories.

const repositoryEntrance = repositoriesBeside ? 0.35 : 0.7;

text(
  repositoryX,
  repositoryHeadingY,
  "Recent Repositories",
  'class="heading"',
  repositoryEntrance,
);

text(
  repositoryX,
  repositoryHeadingY + 23,
  `Last ${PROJECT_DAYS} days`,
  'class="muted"',
  repositoryEntrance + 0.28,
);

let cursor = repositoryHeadingY + 57;

const countLabels = projects.map(
  (project) => `${project.count} ${project.count === 1 ? "commit" : "commits"}`,
);

const countWidth = Math.max(
  85,
  ...countLabels.map((label) => estimatedTextWidth(label)),
);

const countGap = 18;

const repositoryNameWidth = Math.max(
  30,
  repositoryWidth - countWidth - countGap,
);

projects.forEach((project, index) => {
  const clipId = `repository-name-${index}`;

  const rowStart = repositoryEntrance + 0.5 + index * ROW_STAGGER;

  definitions.push(
    `<clipPath
      id="${clipId}"
      clipPathUnits="userSpaceOnUse">
      <rect
        x="${repositoryX}"
        y="${cursor - 19}"
        width="${repositoryNameWidth}"
        height="27"/>
    </clipPath>`,
  );

  linkedText(
    project.url,
    repositoryX,
    cursor,
    clipToWidth(project.nameWithOwner, repositoryNameWidth),
    `class="repo" clip-path="url(#${clipId})"`,
    project.nameWithOwner,
    rowStart,
  );

  text(
    repositoryRight,
    cursor,
    countLabels[index],
    'text-anchor="end"',
    rowStart + 0.12,
  );

  cursor += 32;
});

if (projects.length === 0) {
  text(
    repositoryX,
    cursor,
    repositoriesBeside
      ? "No matching public commits in this period."
      : "No matching public repository commits in this period.",
    'class="muted"',
    repositoryEntrance + 0.5,
  );

  cursor += 32;
}

const height = Math.max(legendBottom + PADDING, cursor + 8);

const typingStyle = `
  text {
    white-space: pre;
  }

  .typing-character {
    white-space: pre;
  }

  @media (prefers-reduced-motion: reduce) {
    .typing-character {
      visibility: visible !important;
    }
  }
`;

const style = `
  text {
    font-family: "Segoe UI", Ubuntu, Arial, sans-serif;
    font-size: 14px;
    font-weight: 400;
    fill: ${TEXT_COLOR};
  }

  .heading {
    font-size: 20px;
    fill: ${TITLE_COLOR};
  }

  .repo {
    font-size: 14px;
    fill: ${TITLE_COLOR};
  }

  .muted {
    font-size: 13px;
    fill-opacity: .9;
  }

  .small {
    font-size: 11px;
    fill-opacity: .85;
  }

  .cell-arrive {
    transform-box: fill-box;
    transform-origin: center;
    animation:
      cell-arrive .55s
      cubic-bezier(.22, 1, .36, 1)
      var(--delay, 0s)
      both;
  }

  .month-divider {
    animation:
      reveal-divider .7s
      ease-out
      var(--delay, 0s)
      both;
  }

  @keyframes cell-arrive {
    from {
      opacity: 0;
      transform: scale(.82);
    }

    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes reveal-divider {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cell-arrive,
    .month-divider {
      animation: none;
      transform: none;
    }
  }

  ${typingStyle}
`;

const recentSvg = `<svg xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${height}"
  viewBox="0 0 ${WIDTH} ${height}"
  role="img"
  aria-labelledby="recent-title recent-description">

  <title id="recent-title">Recent GitHub activity</title>

  <desc id="recent-description">
    A ${WEEKS}-week contribution heatmap and recent public
    repositories with exact counts of your commits in their current
    default-branch histories over the last ${PROJECT_DAYS} days.
    Today is incomplete. Calendar dates follow GitHub contribution buckets.
  </desc>

  <defs>
    ${definitions.join("\n")}
  </defs>

  <style>${style}</style>

  <g class="content">
    ${fragments.join("\n")}
  </g>
</svg>`;

// Separate generation timestamp.

const stampDate = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIMEZONE,
  day: "2-digit",
  month: "long",
  year: "numeric",
}).format(now);

const stampTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
})
  .formatToParts(now)
  .map(({ type, value }) => {
    if (type === "timeZoneName") {
      return (
        {
          MEZ: "CET",
          MESZ: "CEST",
        }[value] ?? value
      );
    }

    return value;
  })
  .join("");

const stampValue = `${stampDate}・${stampTime}`;

const updatedSvg = `<svg xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="75"
  viewBox="0 0 ${WIDTH} 75"
  role="img"
  aria-labelledby="updated-title">

  <title id="updated-title">Last updated: ${escape(
    stampValue,
  )}・${escape(TIMEZONE)}</title>

  <style>
    text {
      font-family: "Segoe UI", Ubuntu, Arial, sans-serif;
      text-anchor: middle;
      font-weight: 400;
    }

    ${typingStyle}
  </style>

  ${textMarkup(
    WIDTH / 2,
    23,
    "Last updated",
    `fill="${TITLE_COLOR}" font-size="15"`,
    0.2,
  )}

  ${textMarkup(
    WIDTH / 2,
    47,
    stampValue,
    `fill="${TEXT_COLOR}" font-size="15"`,
    0.48,
  )}

  ${textMarkup(
    WIDTH / 2,
    65,
    TIMEZONE,
    `fill="${TEXT_COLOR}" font-size="11"`,
    0.76,
  )}
</svg>`;

// Write generated files.

await fs.mkdir(OUTPUT, { recursive: true });

for (const [filename, contents] of [
  ["recent.svg", recentSvg],
  ["updated.svg", updatedSvg],
]) {
  const destination = path.join(OUTPUT, filename);
  const temporary = `${destination}.tmp`;

  await fs.writeFile(temporary, contents, "utf8");
  await fs.rename(temporary, destination);

  console.log(`Generated data/stats/${filename}`);
}

console.log(
  `Recent repositories layout: ${
    repositoriesBeside ? "beside heatmap" : "below heatmap"
  }`,
);
