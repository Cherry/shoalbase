// ChangeLogController's markup of the ChangeLog file: links for URLs, mail addresses, FAQ entries, issues, CVEs, PMASAs and releases.
import { htmlspecialchars } from '../../twig/php.ts';

const GITHUB_URL = 'https://github.com/phpmyadmin/phpmyadmin/';
const FAQ_URL = 'https://docs.phpmyadmin.net/en/latest/faq.html';

// preg_replace() with arrays applies each pattern to the result of the previous one, in this order.
const REPLACES: [RegExp, string][] = [
	// Upstream's [./a-zA-Z0-9.-_-] includes the whole "." to "_" range, spelled out here.
	[/(https?:\/\/[\w\-./:;<=>?@[\\\]^]*[/\w])/g, '<a href="url.php?url=$1">$1</a>'],
	[/(\d{4}-\d{2}-\d{2}) (.+[^ ]) +&lt;([^\n@]*@.*)&gt;/gi, '$1 <a href="mailto:$3">$2</a>'],
	[/FAQ (\d+)\.([0-9a-z]+)/gi, `<a href="url.php?url=${FAQ_URL}#faq$1-$2">FAQ $1.$2</a>`],
	[/issue\s*#?(\d{4,5}) /gi, `<a href="url.php?url=${GITHUB_URL}issues/$1">issue #$1</a> `],
	[/((CAN|CVE)-\d+-\d+)/g, '<a href="url.php?url=https://www.cve.org/CVERecord?id=$1">$1</a>'],
	[/(PMASA-\d+-\d+)/g, '<a href="url.php?url=https://www.phpmyadmin.net/security/$1/">$1</a>'],
	[/(\d+)\.(\d+)\.(\d+)\.0 (\([0-9-]+\))/g, `<a id="$1_$2_$3"></a><a href="url.php?url=${GITHUB_URL}commits/RELEASE_$1_$2_$3">$1.$2.$3.0 $4</a>`],
	[/(\d+)\.(\d+)\.(\d+)\.([1-9]\d*) (\([0-9-]+\))/g, `<a id="$1_$2_$3_$4"></a><a href="url.php?url=${GITHUB_URL}commits/RELEASE_$1_$2_$3_$4">$1.$2.$3.$4 $5</a>`],
	[/( {4}### )(.*)/g, '$1<b>$2</b>'],
	[/a href="/g, 'a target="_blank" rel="noopener noreferrer" href="'],
];

/** The escaped and linked ChangeLog text that changelog.twig puts in its pre element. */
export function formatChangelog(changelog: string): string {
	let text = htmlspecialchars(changelog);
	for (const [pattern, replacement] of REPLACES) {
		// The replacements are constants that use $n group references on purpose.
		// eslint-disable-next-line unicorn/no-unsafe-string-replacement
		text = text.replace(pattern, replacement);
	}
	return text;
}
