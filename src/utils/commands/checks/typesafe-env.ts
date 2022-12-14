/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Checks } from './index.js';
import path from 'path';
import * as fs from 'fs';
import parser, { ParseResult } from '@babel/parser';
import {
	CallExpression,
	File,
	Identifier,
	ImportDeclaration,
	MemberExpression,
	ObjectExpression,
	ObjectProperty,
	VariableDeclarator,
} from '@babel/types';
import { error, log } from '../../log.js';
import { enviromentVariables } from '../../env.js';
import ora from 'ora';
import inquirer from 'inquirer';
import { PossibleType, typeGuesser, zodAST } from '../../type-guesser.js';
import generate from '@babel/generator';
import traverse, { NodePath } from '@babel/traverse';
import { project } from '../../npm.js';

export class TypesafeEnv implements Checks {
	ast: ParseResult<File> | undefined;
	code: string | undefined;
	schemaFilePath: string | undefined;

	check = async () => {
		this.ast = await this.getAST();
		await this.assertZod();

		const schemaEnvVars = await this.getSchemaEnvVars();
		const actualEnvVars = await enviromentVariables();
		await this.assertDotEnv(actualEnvVars, schemaEnvVars);
		await this.checkFiles(schemaEnvVars);

		return;
	};

	private getAST = async () => {
		// We are expecting for the project structure to be like this:
		// src
		// └── env
		//      ├── *.mjs
		//      ├── schema.mjs
		//      └── *.mjs

		const folder = (await project).root;
		const envFolder = path.join(folder, 'src', 'env');

		if (!fs.existsSync(envFolder)) throw new Error(`Could not find env folder at ${envFolder}. Please create it.`);

		const filePaths = fs
			.readdirSync(envFolder)
			.filter((file) => file.endsWith('.mjs'))
			.map((file) => path.join(envFolder, file));

		const schema = fs.readFileSync(filePaths[1], 'utf8');

		this.schemaFilePath = filePaths[1];
		this.code = schema;
		return parser.parse(schema, {
			sourceType: 'module',
		});
	};

	private getSchemaEnvVars = async () => {
		if (!this.ast) throw new Error('AST is not defined');

		const envVars: string[] = [];
		traverse.default(this.ast, {
			ObjectProperty(path: NodePath<ObjectProperty>) {
				if (path.node.key.type === 'Identifier') {
					envVars.push(path.node.key.name);
				}
			},
		});

		return envVars;
	};

	private assertZod = async () => {
		const usingZod = this.ast?.program.body
			.filter((node) => node.type === 'ImportDeclaration')
			.some((node) => (node as ImportDeclaration).source.value === 'zod');

		if (!usingZod) {
			error('This CLI can only work with "zod" and an scaffolded project from "create-t3-app"');
			process.exit(1);
		}
	};

	private assertDotEnv = async (actualEnvVars: string[], schemaEnvVars: string[]) => {
		const missingEnvVars: string[] = [];
		const spinner = ora('Checking env variables').start();

		for (const env of actualEnvVars) {
			const inSpinner = ora(`Checking ${env}`).start();
			if (schemaEnvVars.includes(env)) {
				inSpinner.succeed(`Environment variable $${env} is defined in the schema`);
			} else {
				inSpinner.fail(`Environment variable $${env} is not defined in the schema`);
				missingEnvVars.push(env);
			}
		}

		if (missingEnvVars.length <= 0) {
			spinner.succeed('All environment variables are present in your schema\n');

			return;
		}

		spinner.fail('Some environment variables are missing');
		await this.handleErrors(missingEnvVars);
	};

	private checkFiles = async (schemaEnvVars: string[]) => {
		const spinner = ora('Checking files').start();
		const folder = (await project).root;
		const srcFolder = path.join(folder, 'src');
		const filePaths = await this.recursivelyFindSourceFiles(srcFolder);

		const files = filePaths.map((file) => fs.readFileSync(file, 'utf8'));
		const results = files.map((code) =>
			parser.parse(code, {
				sourceType: 'module',
				plugins: ['typescript', 'jsx'],
			}),
		);
		const asserts = results.map((ast) => this.assertFile(ast, schemaEnvVars));
		const missingEnvVars = new Set(await Promise.all(asserts));
		missingEnvVars.delete(undefined);

		if (missingEnvVars.size > 0) {
			spinner.fail('Some environment variables are missing in your code!');
			await this.handleErrors(Array.from(missingEnvVars));
		}

		spinner.succeed('Finished going through the code');
	};

	private recursivelyFindSourceFiles = async (dir: string): Promise<string[]> => {
		const exts = ['.js', '.jsx', '.ts', '.tsx'];
		const files: string[] = [];

		for (const file of fs.readdirSync(dir)) {
			const filePath = path.join(dir, file);
			if (fs.statSync(filePath).isDirectory())
				files.push(...(await this.recursivelyFindSourceFiles(path.join(dir, file))));
			else if (exts.some((ext) => filePath.includes(ext))) files.push(filePath);
		}

		return files;
	};

	private assertFile = async (ast: ParseResult<File>, schemaEnvVars: string[]): Promise<string | undefined> => {
		let result: string | undefined;
		// TODO: Traversing the AST twice (this.assertDotEnv)
		traverse.default(await ast, {
			MemberExpression: (path: NodePath<MemberExpression>) => {
				const process = (path.node?.object as MemberExpression)?.object as Identifier;
				if (process?.name !== 'process') return;

				const env = (path.node?.object as MemberExpression)?.property as Identifier;
				if (env?.name !== 'env') return;

				const envName = path.node?.property as Identifier;
				if (!envName || !envName.name || schemaEnvVars.some((env) => env === envName.name)) return;

				result = envName.name;
			},
		});

		return result;
	};

	/*
	 * We will ask the user if they want to add the missing env variables
	 * to the schema. If they do, we will add them and write the file.
	 * We also try to infer the type of the variable from the name.
	 */
	private handleErrors = async (envVars: (string | undefined)[]) => {
		for (const env of envVars) {
			if (!env || !(await this.confirm(env))) continue;

			const type = await this.promptType(env);
			traverse.default(this.ast, {
				ObjectExpression(path: NodePath<ObjectExpression>) {
					const isZod =
						(((path.parent as CallExpression)?.callee as MemberExpression)?.object as Identifier)?.name === 'z';

					const isServerSchema =
						(((path.parentPath as NodePath<CallExpression>)?.parent as VariableDeclarator)?.id as Identifier)?.name ===
						'serverSchema';

					if (isZod && isServerSchema) {
						path.node.properties.push(zodAST(env, type));
					}
				},
			});
		}

		const output = generate.default(this.ast!, {}, this.code);
		fs.writeFileSync(this.schemaFilePath!, output.code);
	};

	private confirm = async (env: string) => {
		const { confirm } = await inquirer.prompt<{ confirm: boolean }>({
			type: 'confirm',
			name: 'confirm',
			message: `Do you want to add $${env} to the schema?`,
			default: true,
		});

		return confirm;
	};

	private promptType = async (env: string): Promise<PossibleType> => {
		const { type } = await inquirer.prompt<{ type: PossibleType }>({
			type: 'list',
			name: 'type',
			message: `What type is $${env}? (we guessed the order)`,
			choices: typeGuesser(env),
			default: 0,
		});

		if (type === 'other') log('You are going to have to add it manually!');

		return type;
	};
}
