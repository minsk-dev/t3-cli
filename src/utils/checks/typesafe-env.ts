import { Checks } from './index.js';
import { findNpmRoot } from '../npm.js';
import path from 'path';
import * as fs from 'fs';
import parser, { ParseResult } from '@babel/parser';
import {
	CallExpression,
	ExportNamedDeclaration,
	File,
	Identifier,
	ImportDeclaration,
	ObjectExpression,
	ObjectProperty,
	VariableDeclaration,
} from '@babel/types';
import { error } from '../log.js';
import { enviromentVariables } from '../env.js';
import ora from 'ora';
import inquirer from 'inquirer';
import { PossibleType, typeGuesser } from '../type-guesser.js';

const getAST = async () => {
	// We are expecting for the project structure to be like this:
	// src
	// └── env
	//      ├─── *.mjs
	//      ├── schema.mjs
	//      └── *.mjs

	const folder = await findNpmRoot(process.cwd());
	const envFolder = path.join(folder, 'src', 'env');

	if (!fs.existsSync(envFolder))
		throw new Error(
			`Could not find env folder at ${envFolder}. Please create it.`,
		);

	const files = fs
		.readdirSync(envFolder)
		.filter((file) => file.endsWith('.mjs'))
		.map((file) => path.join(envFolder, file))
		.map((file) => fs.readFileSync(file, 'utf8'));

	const schema = files[1]; // TODO: Find the schema file

	return parser.parse(schema, {
		sourceType: 'module',
	});
};

export class TypesafeEnv implements Checks {
	check = async () => {
		const ast = await getAST();
		await this.assertZod(ast);

		const schemaEnvVars = await this.getSchemaEnvVars(ast);
		const actualEnvVars = await enviromentVariables();
		const missingEnvVars: string[] = [];
		const spinner = ora('Checking env variables').start();

		for (const env of actualEnvVars) {
			const inSpinner = ora(`Checking ${env}`).start();
			if (!schemaEnvVars.includes(env)) {
				inSpinner.fail(`Env variable ${env} is not defined in the schema`);
				missingEnvVars.push(env);
			} else {
				inSpinner.succeed(`Env variable ${env} is defined in the schema`);
			}
		}

		if (missingEnvVars.length > 0) {
			spinner.fail('Some environment variables are missing');
			await this.handleErrors(missingEnvVars);

			return;
		}

		spinner.succeed('All env variables are present in your schema');
	};

	private getSchemaEnvVars = async (ast: ParseResult<File>) => {
		const declarators = ast.program.body
			.filter((node) => node.type === 'ExportNamedDeclaration')
			.map((node) => (node as ExportNamedDeclaration).declaration)
			.filter((node) => node?.type === 'VariableDeclaration')
			.map((node) => (node as VariableDeclaration).declarations)
			.flat(); // [][] -> []

		const schemas = declarators
			.map((declarator) => declarator.init)
			.filter((init) => init?.type === 'CallExpression')
			.map((init) => (init as CallExpression)?.arguments)
			.flat()
			.filter((arg) => arg?.type === 'ObjectExpression')
			.map((arg) => (arg as ObjectExpression).properties)
			.flat();

		return schemas
			.filter((field) => field.type === 'ObjectProperty')
			.map((schema) => (schema as ObjectProperty).key)
			.filter((key) => key.type === 'Identifier')
			.map((key) => (key as Identifier).name);
	};

	private assertZod = async (ast: ParseResult<File>) => {
		const usingZod = ast.program.body
			.filter((node) => node.type === 'ImportDeclaration')
			.some((node) => (node as ImportDeclaration).source.value === 'zod');

		if (!usingZod) {
			error(
				'This CLI can only work with "zod" and an scaffolded project from "create-t3-app"',
			);
			process.exit(1);
		}
	};

	/*
	 * We will ask the user if they want to add the missing env variables
	 * to the schema. If they do, we will add them and write the file.
	 * We also try to infer the type of the variable from the name.
	 */
	private handleErrors = async (envVars: string[]) => {
		for (const env of envVars) {
			if (!(await this.confirm())) continue;

			const type = await this.promptType(env);
		}
	};

	private confirm = async () => {
		const { confirm } = await inquirer.prompt<{ confirm: boolean }>({
			type: 'confirm',
			name: 'confirm',
			message: 'Do you want to add the missing env variables to your schema?',
			default: true,
		});

		return confirm;
	};

	private promptType = async (env: string): Promise<PossibleType> => {
		const { type } = await inquirer.prompt<{ type: PossibleType }>({
			type: 'list',
			name: 'type',
			message: `What type is ${env}?`,
			choices: typeGuesser(env),
		});

		return type;
	};
}
