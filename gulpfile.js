/*
   Copyright 2016 Yuki KAN

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
'use strict';

var fs = require('fs');
var gulp = require('gulp');
var typescript = require('gulp-typescript');
var sourcemaps = require('gulp-sourcemaps');
var rename = require('gulp-rename');
var del = require('del');

gulp.task('clean', () => {
    del.sync(['lib']);
});

gulp.task('tsc', () => {
    return gulp
        .src([
            'src/**/*.ts'
        ])
        .pipe(sourcemaps.init())
        .pipe(typescript({
            target: 'ES6',
            module: 'commonjs',
            declarationFiles: false
        }))
        .js
        .pipe(sourcemaps.write('./'))
        .pipe(gulp.dest('lib'));
});

gulp.task('build', ['clean', 'tsc']);

gulp.task('watch', function () {
    gulp.watch('src/**/*.ts', ['build']);
});

gulp.task('default', ['build']);