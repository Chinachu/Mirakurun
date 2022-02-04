const { NODE_ENV } = process.env;
const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
    mode: NODE_ENV === "production" ? "production" : "development",
    devtool: "source-map",
    watchOptions: {
        ignored: /node_modules/
    },
    entry: {
        index: `${__dirname}/src/ui/index.tsx`
    },
    output: {
        path: `${__dirname}/lib/ui`,
        filename: "[name].bundle.js"
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: [
                    {
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.webpack.json"
                        }
                    }
                ]
            },
            {
                test: /\.css$/,
                use: ["style-loader", "css-loader"]
            }
        ]
    },
    resolve: {
        extensions: [".ts", ".tsx", ".js", ".json"]
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    // globby can't glob Windows-style(contain '\') path
                    from: `${__dirname}/src/ui/**/*.{html,svg}`.replace(/\\/g, '/'),
                    to: `${__dirname}/lib/ui`,
                    context: `${__dirname}/src/ui`
                }
            ]
        }),
        new webpack.ProvidePlugin({
            Buffer: ["buffer", "Buffer"]
        }),
        new webpack.ProvidePlugin({
            process: "process/browser"
        })
    ],
    optimization: {
        splitChunks: {
            cacheGroups: {
                vendors: {
                    test: /node_modules/,
                    name: "vendors",
                    chunks: "all",
                    enforce: true
                }
            }
        }
    }
};
