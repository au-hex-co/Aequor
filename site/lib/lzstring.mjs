// Decode-only port of lz-string's decompressFromBase64 (pieroxy/lz-string,
// MIT). The Obsidian Excalidraw plugin compresses its scene JSON with this
// exact algorithm before embedding it as a ```compressed-json fenced block,
// so this is the only way to read that data back out without adding a
// dependency — it's ~90 lines, so it's cheaper to vendor than to install.

const KEY_STR_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

let baseValueCache = null;
function getBaseValue(character) {
	if (!baseValueCache) {
		baseValueCache = {};
		for (let i = 0; i < KEY_STR_BASE64.length; i++) baseValueCache[KEY_STR_BASE64.charAt(i)] = i;
	}
	return baseValueCache[character];
}

function readBits(numBits, data, resetValue, getNextValue) {
	let bits = 0;
	let maxpower = Math.pow(2, numBits);
	let power = 1;
	while (power !== maxpower) {
		const resb = data.val & data.position;
		data.position >>= 1;
		if (data.position === 0) {
			data.position = resetValue;
			data.val = getNextValue(data.index++);
		}
		bits |= (resb > 0 ? 1 : 0) * power;
		power <<= 1;
	}
	return bits;
}

function decompress(length, resetValue, getNextValue) {
	const dictionary = [0, 1, 2];
	let enlargeIn = 4;
	let dictSize = 4;
	let numBits = 3;
	let entry = "";
	const result = [];
	const data = { val: getNextValue(0), position: resetValue, index: 1 };

	const first = readBits(2, data, resetValue, getNextValue);
	let c;
	if (first === 0) c = String.fromCharCode(readBits(8, data, resetValue, getNextValue));
	else if (first === 1) c = String.fromCharCode(readBits(16, data, resetValue, getNextValue));
	else return "";

	dictionary[3] = c;
	let w = c;
	result.push(c);

	while (true) {
		if (data.index > length) return "";
		const bits = readBits(numBits, data, resetValue, getNextValue);

		let cCode = bits;
		if (cCode === 0) {
			dictionary[dictSize++] = String.fromCharCode(readBits(8, data, resetValue, getNextValue));
			cCode = dictSize - 1;
			enlargeIn--;
		} else if (cCode === 1) {
			dictionary[dictSize++] = String.fromCharCode(readBits(16, data, resetValue, getNextValue));
			cCode = dictSize - 1;
			enlargeIn--;
		} else if (cCode === 2) {
			return result.join("");
		}

		if (enlargeIn === 0) {
			enlargeIn = Math.pow(2, numBits);
			numBits++;
		}

		if (dictionary[cCode]) {
			entry = dictionary[cCode];
		} else if (cCode === dictSize) {
			entry = w + w.charAt(0);
		} else {
			return null;
		}

		result.push(entry);
		dictionary[dictSize++] = w + entry.charAt(0);
		enlargeIn--;
		w = entry;

		if (enlargeIn === 0) {
			enlargeIn = Math.pow(2, numBits);
			numBits++;
		}
	}
}

export function decompressFromBase64(input) {
	if (input == null) return "";
	if (input === "") return null;
	return decompress(input.length, 32, (index) => getBaseValue(input.charAt(index)));
}
