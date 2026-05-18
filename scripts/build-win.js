'use strict';

const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const root = path.join(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const localBuildPath = path.join(root, '.build', 'build-number');
const buildInfoPath = path.join(root, 'src', 'build-info.json');
const packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = String(process.env.ALORBACH_BRIDGE_VERSION || packageInfo.version || '1.0.1').replace(/^v/, '');

function readLocalBuildNumber() {
	try {
		const raw = fs.readFileSync(localBuildPath, 'utf8').trim();
		return Number.parseInt(raw, 10) || 0;
	} catch (error) {
		return 0;
	}
}

function nextBuildNumber() {
	if (process.env.ALORBACH_BRIDGE_BUILD) {
		return Number.parseInt(process.env.ALORBACH_BRIDGE_BUILD, 10) || 1;
	}
	if (process.env.GITHUB_RUN_NUMBER) {
		return Number.parseInt(process.env.GITHUB_RUN_NUMBER, 10) || 1;
	}
	const next = readLocalBuildNumber() + 1;
	fs.mkdirSync(path.dirname(localBuildPath), { recursive: true });
	fs.writeFileSync(localBuildPath, String(next));
	return next;
}

const buildNumber = nextBuildNumber();
const numericVersion = version.split('-')[0].split('+')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
while (numericVersion.length < 3) {
	numericVersion.push(0);
}
const buildVersion = `${numericVersion[0]}.${numericVersion[1]}.${numericVersion[2]}.${buildNumber}`;

fs.writeFileSync(buildInfoPath, JSON.stringify({
	version,
	build_number: buildNumber,
	build_version: buildVersion,
	built_at: new Date().toISOString(),
}, null, 2) + '\n');

const artifactName = `Codex-Local-Bridge-${version}-build.${buildNumber}-\${os}-\${arch}.\${ext}`;

builder.build({
	projectDir: root,
	targets: builder.Platform.WINDOWS.createTarget(['nsis', 'zip'], builder.Arch.x64),
	publish: 'never',
	config: {
		buildVersion,
		artifactName,
	},
}).catch((error) => {
	process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
	process.exit(1);
});
